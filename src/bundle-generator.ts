import * as ts from 'typescript';
import * as path from 'path';

import { compileDts } from './compile-dts';
import { TypesUsageEvaluator } from './types-usage-evaluator';
import {
	getActualSymbol,
	getDeclarationsForSymbol,
	getExportsForSourceFile,
	getExportsForStatement,
	hasNodeModifier,
	isAmbientModule,
	isDeclarationFromExternalModule,
	isDeclareGlobalStatement,
	isDeclareModuleStatement,
	isNamespaceStatement,
	isNodeNamedDeclaration,
	SourceFileExport,
	splitTransientSymbol,
} from './helpers/typescript';

import { fixPath } from './helpers/fix-path';

import {
	getModuleInfo,
	ModuleCriteria,
	ModuleInfo,
	ModuleType,
} from './module-info';

import { generateOutput, ModuleImportsSet } from './generate-output';

import {
	normalLog,
	verboseLog,
	warnLog,
} from './logger';

export interface CompilationOptions {
	/**
	 * EXPERIMENTAL!
	 * Allows disable resolving of symlinks to the original path.
	 * By default following is enabled.
	 * @see https://github.com/timocov/dts-bundle-generator/issues/39
	 */
	followSymlinks?: boolean;

	/**
	 * Path to the tsconfig file that will be used for the compilation.
	 */
	preferredConfigPath?: string;
}

export interface OutputOptions {
	/**
	 * Sort output nodes in ascendant order.
	 */
	sortNodes?: boolean;

	/**
	 * Name of the UMD module.
	 * If specified then `export as namespace ModuleName;` will be emitted.
	 */
	umdModuleName?: string;

	/**
	 * Enables inlining of `declare global` statements contained in files which should be inlined (all local files and packages from inlined libraries).
	 */
	inlineDeclareGlobals?: boolean;

	/**
	 * Enables inlining of `declare module` statements of the global modules
	 * (e.g. `declare module 'external-module' {}`, but NOT `declare module './internal-module' {}`)
	 * contained in files which should be inlined (all local files and packages from inlined libraries)
	 */
	inlineDeclareExternals?: boolean;

	/**
	 * Allows remove "Generated by dts-bundle-generator" comment from the output
	 */
	noBanner?: boolean;

	/**
	 * Enables stripping the `const` keyword from every direct-exported (or re-exported) from entry file `const enum`.
	 * This allows you "avoid" the issue described in https://github.com/microsoft/TypeScript/issues/37774.
	 */
	respectPreserveConstEnum?: boolean;
}

export interface LibrariesOptions {
	/**
	 * Array of package names from node_modules to inline typings from.
	 * Used types will be inlined into the output file.
	 */
	inlinedLibraries?: string[];

	/**
	 * Array of package names from node_modules to import typings from.
	 * Used types will be imported using `import { First, Second } from 'library-name';`.
	 * By default all libraries will be imported (except inlined libraries and libraries from @types).
	 */
	importedLibraries?: string[];

	/**
	 * Array of package names from @types to import typings from via the triple-slash reference directive.
	 * By default all packages are allowed and will be used according to their usages.
	 */
	allowedTypesLibraries?: string[];
}

export interface EntryPointConfig {
	/**
	 * Path to input file.
	 */
	filePath: string;

	libraries?: LibrariesOptions;

	/**
	 * Fail if generated dts contains class declaration.
	 */
	failOnClass?: boolean;

	output?: OutputOptions;
}

export function generateDtsBundle(entries: ReadonlyArray<EntryPointConfig>, options: CompilationOptions = {}): string[] {
	normalLog('Compiling input files...');

	const { program, rootFilesRemapping } = compileDts(entries.map((entry: EntryPointConfig) => entry.filePath), options.preferredConfigPath, options.followSymlinks);
	const typeChecker = program.getTypeChecker();

	const typeRoots = ts.getEffectiveTypeRoots(program.getCompilerOptions(), {});

	const sourceFiles = program.getSourceFiles().filter((file: ts.SourceFile) => {
		return !isSourceFileDefaultLibrary(program, file);
	});

	verboseLog(`Input source files:\n  ${sourceFiles.map((file: ts.SourceFile) => file.fileName).join('\n  ')}`);

	const typesUsageEvaluator = new TypesUsageEvaluator(sourceFiles, typeChecker);

	// tslint:disable-next-line:cyclomatic-complexity
	return entries.map((entry: EntryPointConfig) => {
		normalLog(`Processing ${entry.filePath}`);

		const newRootFilePath = rootFilesRemapping.get(entry.filePath);
		if (newRootFilePath === undefined) {
			throw new Error(`Cannot remap root source file ${entry.filePath}`);
		}

		const rootSourceFile = getRootSourceFile(program, newRootFilePath);
		const rootSourceFileSymbol = typeChecker.getSymbolAtLocation(rootSourceFile);
		if (rootSourceFileSymbol === undefined) {
			throw new Error(`Symbol for root source file ${newRootFilePath} not found`);
		}

		const librariesOptions: LibrariesOptions = entry.libraries || {};

		const criteria: ModuleCriteria = {
			allowedTypesLibraries: librariesOptions.allowedTypesLibraries,
			importedLibraries: librariesOptions.importedLibraries,
			inlinedLibraries: librariesOptions.inlinedLibraries || [],
			typeRoots,
		};

		const rootFileExports = getExportsForSourceFile(typeChecker, rootSourceFileSymbol);
		const rootFileExportSymbols = rootFileExports.map((exp: SourceFileExport) => exp.symbol);

		const collectionResult: CollectingResult = {
			typesReferences: new Set(),
			imports: new Map(),
			statements: [],
			renamedExports: [],
		};

		const outputOptions: OutputOptions = entry.output || {};

		const updateResultCommonParams = {
			isStatementUsed: (statement: ts.Statement | ts.SourceFile) => isNodeUsed(statement, rootFileExportSymbols, typesUsageEvaluator, typeChecker),
			shouldStatementBeImported: (statement: ts.DeclarationStatement) => {
				return shouldNodeBeImported(
					statement,
					rootFileExportSymbols,
					typesUsageEvaluator,
					typeChecker,
					isSourceFileDefaultLibrary.bind(null, program)
				);
			},
			shouldDeclareGlobalBeInlined: (currentModule: ModuleInfo) => Boolean(outputOptions.inlineDeclareGlobals) && currentModule.type === ModuleType.ShouldBeInlined,
			shouldDeclareExternalModuleBeInlined: () => Boolean(outputOptions.inlineDeclareExternals),
			getModuleInfo: (fileName: string) => getModuleInfo(fileName, criteria),
			resolveIdentifier: (identifier: ts.Identifier) => {
				const symbol = getDeclarationNameSymbol(identifier, typeChecker);
				if (symbol === null) {
					return undefined;
				}

				const declarations = getDeclarationsForSymbol(symbol);
				if (declarations.length === 0) {
					return undefined;
				}

				const decl = declarations[0];
				if (!isNodeNamedDeclaration(decl)) {
					return undefined;
				}

				return decl.name;
			},
			getDeclarationsForExportedAssignment: (exportAssignment: ts.ExportAssignment) => {
				const symbolForExpression = typeChecker.getSymbolAtLocation(exportAssignment.expression);
				if (symbolForExpression === undefined) {
					return [];
				}

				const symbol = getActualSymbol(symbolForExpression, typeChecker);
				return getDeclarationsForSymbol(symbol);
			},
			getDeclarationUsagesSourceFiles: (declaration: ts.NamedDeclaration) => {
				return getDeclarationUsagesSourceFiles(declaration, rootFileExportSymbols, typesUsageEvaluator, typeChecker);
			},
			areDeclarationSame: (left: ts.NamedDeclaration, right: ts.NamedDeclaration) => {
				const leftSymbols = splitTransientSymbol(getNodeSymbol(left, typeChecker) as ts.Symbol, typeChecker);
				const rightSymbols = splitTransientSymbol(getNodeSymbol(right, typeChecker) as ts.Symbol, typeChecker);

				return leftSymbols.some((leftSymbol: ts.Symbol) => rightSymbols.includes(leftSymbol));
			},
		};

		for (const sourceFile of sourceFiles) {
			verboseLog(`\n\n======= Preparing file: ${sourceFile.fileName} =======`);

			const prevStatementsCount = collectionResult.statements.length;
			const updateFn = sourceFile === rootSourceFile ? updateResultForRootSourceFile : updateResult;
			const currentModule = getModuleInfo(sourceFile.fileName, criteria);
			const params: UpdateParams = {
				...updateResultCommonParams,
				currentModule,
				statements: sourceFile.statements,
			};

			updateFn(params, collectionResult);

			// handle `import * as module` usage if it's used as whole module
			if (currentModule.type === ModuleType.ShouldBeImported && updateResultCommonParams.isStatementUsed(sourceFile)) {
				updateImportsForStatement(sourceFile, params, collectionResult);
			}

			if (collectionResult.statements.length === prevStatementsCount) {
				verboseLog(`No output for file: ${sourceFile.fileName}`);
			}
		}

		if (entry.failOnClass) {
			const classes = collectionResult.statements.filter(ts.isClassDeclaration);
			if (classes.length !== 0) {
				const classesNames = classes.map((c: ts.ClassDeclaration) => c.name === undefined ? 'anonymous class' : c.name.text);
				throw new Error(`${classes.length} class statement(s) are found in generated dts: ${classesNames.join(', ')}`);
			}
		}

		return generateOutput(
			{
				...collectionResult,
				needStripDefaultKeywordForStatement: (statement: ts.Statement) => {
					const statementExports = getExportsForStatement(rootFileExports, typeChecker, statement);

					// if true - no direct export was found
					// that means that node might have an export keyword (like interface, type, etc)
					// otherwise, if there are only re-exports with renaming (like export { foo as bar })
					// we don't need to put export keyword for this statement
					// because we'll re-export it in the way
					return statementExports.find((exp: SourceFileExport) => exp.exportedName === 'default') === undefined;
				},

				shouldStatementHasExportKeyword: (statement: ts.Statement) => {
					const statementExports = getExportsForStatement(rootFileExports, typeChecker, statement);

					// if true - no direct export was found
					// that means that node might have an export keyword (like interface, type, etc)
					// otherwise, if there are only re-exports with renaming (like export { foo as bar })
					// we don't need to put export keyword for this statement
					// because we'll re-export it in the way
					let result = statementExports.length === 0 || statementExports.find((exp: SourceFileExport) => exp.exportedName === exp.symbol.escapedName) !== undefined;

					if (ts.isClassDeclaration(statement)
						|| ts.isEnumDeclaration(statement)
						|| ts.isFunctionDeclaration(statement)
						|| ts.isVariableStatement(statement)
					) {
						// "valuable" statements must be re-exported from root source file
						// to having export keyword in declaration fle
						result = result && statementExports.length !== 0;

						if (ts.isEnumDeclaration(statement)) {
							// const enum always can be exported
							result = result || hasNodeModifier(statement, ts.SyntaxKind.ConstKeyword);
						}
					} else if (isAmbientModule(statement) || ts.isExportDeclaration(statement)) {
						result = false;
					}

					return result;
				},
				needStripConstFromConstEnum: (constEnum: ts.EnumDeclaration) => {
					if (!program.getCompilerOptions().preserveConstEnums || !outputOptions.respectPreserveConstEnum) {
						return false;
					}

					const enumSymbol = getNodeSymbol(constEnum, typeChecker);
					if (enumSymbol === null) {
						return false;
					}

					return rootFileExportSymbols.includes(enumSymbol);
				},
			},
			{
				sortStatements: outputOptions.sortNodes,
				umdModuleName: outputOptions.umdModuleName,
				noBanner: outputOptions.noBanner,
			}
		);
	});
}

interface CollectingResult {
	typesReferences: Set<string>;
	imports: Map<string, ModuleImportsSet>;
	statements: ts.Statement[];
	renamedExports: string[];
}

interface UpdateParams {
	currentModule: ModuleInfo;
	statements: ReadonlyArray<ts.Statement>;
	isStatementUsed(statement: ts.Statement): boolean;
	shouldStatementBeImported(statement: ts.DeclarationStatement): boolean;
	shouldDeclareGlobalBeInlined(currentModule: ModuleInfo, statement: ts.ModuleDeclaration): boolean;
	shouldDeclareExternalModuleBeInlined(): boolean;
	getModuleInfo(fileName: string): ModuleInfo;
	/**
	 * Returns original name which is referenced by passed identifier.
	 * Could be used to resolve "default" identifier in exports.
	 */
	resolveIdentifier(identifier: ts.NamedDeclaration['name']): ts.NamedDeclaration['name'];
	getDeclarationsForExportedAssignment(exportAssignment: ts.ExportAssignment): ts.Declaration[];
	getDeclarationUsagesSourceFiles(declaration: ts.NamedDeclaration): Set<ts.SourceFile>;
	areDeclarationSame(a: ts.NamedDeclaration, b: ts.NamedDeclaration): boolean;
}

const skippedNodes = [
	ts.SyntaxKind.ExportDeclaration,
	ts.SyntaxKind.ImportDeclaration,
	ts.SyntaxKind.ImportEqualsDeclaration,
];

// tslint:disable-next-line:cyclomatic-complexity
function updateResult(params: UpdateParams, result: CollectingResult): void {
	for (const statement of params.statements) {
		// we should skip import and exports statements
		if (skippedNodes.indexOf(statement.kind) !== -1) {
			continue;
		}

		if (isDeclareModuleStatement(statement)) {
			updateResultForModuleDeclaration(statement, params, result);
			continue;
		}

		if (params.currentModule.type === ModuleType.ShouldBeUsedForModulesOnly) {
			continue;
		}

		if (isDeclareGlobalStatement(statement) && params.shouldDeclareGlobalBeInlined(params.currentModule, statement)) {
			result.statements.push(statement);
			continue;
		}

		if (ts.isExportAssignment(statement) && statement.isExportEquals && params.currentModule.type === ModuleType.ShouldBeImported) {
			updateResultForImportedEqExportAssignment(statement, params, result);
			continue;
		}

		if (!params.isStatementUsed(statement)) {
			verboseLog(`Skip file member: ${statement.getText().replace(/(\n|\r)/g, '').slice(0, 50)}...`);
			continue;
		}

		switch (params.currentModule.type) {
			case ModuleType.ShouldBeReferencedAsTypes:
				addTypesReference(params.currentModule.typesLibraryName, result.typesReferences);
				break;

			case ModuleType.ShouldBeImported:
				updateImportsForStatement(statement, params, result);
				break;

			case ModuleType.ShouldBeInlined:
				result.statements.push(statement);
				break;
		}
	}
}

// tslint:disable-next-line:cyclomatic-complexity
function updateResultForRootSourceFile(params: UpdateParams, result: CollectingResult): void {
	function isReExportFromImportableModule(statement: ts.Statement): boolean {
		if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) {
			return false;
		}

		const moduleFileName = resolveModuleFileName(statement.getSourceFile().fileName, statement.moduleSpecifier.text);
		return params.getModuleInfo(moduleFileName).type === ModuleType.ShouldBeImported;
	}

	updateResult(params, result);

	// add skipped by `updateResult` exports
	for (const statement of params.statements) {
		// "export default" or "export ="
		const isExportAssignment = ts.isExportAssignment(statement);
		const isReExportFromImportable = isReExportFromImportableModule(statement);

		if (isExportAssignment || isReExportFromImportable) {
			result.statements.push(statement);
		}

		// export { foo, bar, baz as fooBar }
		if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
			for (const exportItem of statement.exportClause.elements) {
				if (exportItem.name.getText() === 'default' && exportItem.propertyName === undefined) {
					// export { default }
					// return export { /get name of exportItem.name's symbol node/ as default };
					// it seems unnecessary?
					continue;
				}

				if (exportItem.propertyName !== undefined && exportItem.propertyName.getText() === 'default') {
					const resolvedIdentifier = params.resolveIdentifier(exportItem.propertyName);
					// export { default as name }
					result.renamedExports.push(`${resolvedIdentifier?.getText() || ''} as ${exportItem.name.getText()}`);
					continue;
				}

				// export { baz as propertyName }
				if (exportItem.propertyName !== undefined) {
					result.renamedExports.push(exportItem.getText());
				}
			}
		}
	}
}

function updateResultForImportedEqExportAssignment(exportAssignment: ts.ExportAssignment, params: UpdateParams, result: CollectingResult): void {
	const moduleDeclarations = params.getDeclarationsForExportedAssignment(exportAssignment)
		.filter(isNamespaceStatement)
		.filter((s: ts.ModuleDeclaration) => s.getSourceFile() === exportAssignment.getSourceFile());

	// if we have `export =` somewhere so we can decide that every declaration of exported symbol in this way
	// is "part of the exported module" and we need to update result according every member of each declaration
	// but treat they as current module (we do not need to update module info)
	for (const moduleDeclaration of moduleDeclarations) {
		if (moduleDeclaration.body === undefined || !ts.isModuleBlock(moduleDeclaration.body)) {
			continue;
		}

		updateResult(
			{
				...params,
				statements: moduleDeclaration.body.statements,
			},
			result
		);
	}
}

function updateResultForModuleDeclaration(moduleDecl: ts.ModuleDeclaration, params: UpdateParams, result: CollectingResult): void {
	if (moduleDecl.body === undefined || !ts.isModuleBlock(moduleDecl.body)) {
		return;
	}

	const moduleName = moduleDecl.name.text;
	const moduleFileName = resolveModuleFileName(params.currentModule.fileName, moduleName);
	const moduleInfo = params.getModuleInfo(moduleFileName);

	// if we have declaration of external module inside internal one
	if (!params.currentModule.isExternal && moduleInfo.isExternal) {
		// if it's allowed - we need to just add it to result without any processing
		if (params.shouldDeclareExternalModuleBeInlined()) {
			result.statements.push(moduleDecl);
		}

		return;
	}

	updateResult(
		{
			...params,
			currentModule: moduleInfo,
			statements: moduleDecl.body.statements,
		},
		result
	);
}

function resolveModuleFileName(currentFileName: string, moduleName: string): string {
	return moduleName.startsWith('.') ? fixPath(path.join(currentFileName, '..', moduleName)) : `node_modules/${moduleName}/`;
}

function addTypesReference(library: string, typesReferences: Set<string>): void {
	if (!typesReferences.has(library)) {
		normalLog(`Library "${library}" will be added via reference directive`);
		typesReferences.add(library);
	}
}

function updateImportsForStatement(statement: ts.Statement | ts.SourceFile, params: UpdateParams, result: CollectingResult): void {
	if (params.currentModule.type !== ModuleType.ShouldBeImported) {
		return;
	}

	const statementsToImport = ts.isVariableStatement(statement) ? statement.declarationList.declarations : [statement];
	for (const statementToImport of statementsToImport) {
		if (params.shouldStatementBeImported(statementToImport as ts.DeclarationStatement)) {
			addImport(statementToImport as ts.DeclarationStatement, params, result.imports);

			// if we're going to add import of any statement in the bundle
			// we should check whether the library of that statement
			// could be referenced via triple-slash reference-types directive
			// because the project which will use bundled declaration file
			// can have `types: []` in the tsconfig and it'll fail
			// this is especially related to the types packages
			// which declares different modules in their declarations
			// e.g. @types/node has declaration for "packages" events, fs, path and so on
			const sourceFile = statementToImport.getSourceFile();
			const moduleInfo = params.getModuleInfo(sourceFile.fileName);
			if (moduleInfo.type === ModuleType.ShouldBeReferencedAsTypes) {
				addTypesReference(moduleInfo.typesLibraryName, result.typesReferences);
			}
		}
	}
}

function getDeclarationUsagesSourceFiles(
	declaration: ts.NamedDeclaration,
	rootFileExports: ReadonlyArray<ts.Symbol>,
	typesUsageEvaluator: TypesUsageEvaluator,
	typeChecker: ts.TypeChecker
): Set<ts.SourceFile> {
	return new Set(
		getExportedSymbolsUsingStatement(declaration, rootFileExports, typesUsageEvaluator, typeChecker)
			.map((symbol: ts.Symbol) => getDeclarationsForSymbol(symbol))
			.reduce((acc: ts.Declaration[], val: ts.Declaration[]) => acc.concat(val), [])
			.map((declaration: ts.Declaration) => declaration.getSourceFile())
	);
}

function getImportModuleName(imp: ts.ImportEqualsDeclaration | ts.ImportDeclaration): string | null {
	if (ts.isImportDeclaration(imp)) {
		const importClause = imp.importClause;
		if (importClause === undefined) {
			return null;
		}

		return (imp.moduleSpecifier as ts.StringLiteral).text;
	}

	if (ts.isExternalModuleReference(imp.moduleReference)) {
		if (!ts.isStringLiteral(imp.moduleReference.expression)) {
			warnLog(`Cannot handle non string-literal-like import expression: ${imp.moduleReference.expression.getText()}`);
			return null;
		}

		return imp.moduleReference.expression.text;
	}

	return null;
}

function addImport(statement: ts.DeclarationStatement, params: UpdateParams, imports: CollectingResult['imports']): void {
	if (statement.name === undefined) {
		throw new Error(`Import/usage unnamed declaration: ${statement.getText()}`);
	}

	params.getDeclarationUsagesSourceFiles(statement).forEach((sourceFile: ts.SourceFile) => {
		sourceFile.statements.forEach((st: ts.Statement) => {
			if (!ts.isImportEqualsDeclaration(st) && !ts.isImportDeclaration(st)) {
				return;
			}

			const importModuleSpecifier = getImportModuleName(st);
			if (importModuleSpecifier === null) {
				return;
			}

			let importItem = imports.get(importModuleSpecifier);
			if (importItem === undefined) {
				importItem = {
					defaultImports: new Set<string>(),
					namedImports: new Set<string>(),
					starImports: new Set<string>(),
					requireImports: new Set<string>(),
				};

				imports.set(importModuleSpecifier, importItem);
			}

			if (ts.isImportEqualsDeclaration(st)) {
				if (params.areDeclarationSame(statement, st)) {
					importItem.requireImports.add(st.name.text);
				}

				return;
			}

			const importClause = st.importClause as ts.ImportClause;
			if (importClause.name !== undefined && params.areDeclarationSame(statement, importClause)) {
				// import name from 'module';
				importItem.defaultImports.add(importClause.name.text);
			}

			if (importClause.namedBindings !== undefined) {
				if (ts.isNamedImports(importClause.namedBindings)) {
					// import { El1, El2 } from 'module';
					importClause.namedBindings.elements
						.filter(params.areDeclarationSame.bind(params, statement))
						.forEach((specifier: ts.ImportSpecifier) => (importItem as ModuleImportsSet).namedImports.add(specifier.getText()));
				} else {
					// import * as name from 'module';
					importItem.starImports.add(importClause.namedBindings.name.getText());
				}
			}
		});
	});
}

function getRootSourceFile(program: ts.Program, rootFileName: string): ts.SourceFile {
	if (program.getRootFileNames().indexOf(rootFileName) === -1) {
		throw new Error(`There is no such root file ${rootFileName}`);
	}

	const sourceFile = program.getSourceFile(rootFileName);
	if (sourceFile === undefined) {
		throw new Error(`Cannot get source file for root file ${rootFileName}`);
	}

	return sourceFile;
}

function isNodeUsed(
	node: ts.Node,
	rootFileExports: ReadonlyArray<ts.Symbol>,
	typesUsageEvaluator: TypesUsageEvaluator,
	typeChecker: ts.TypeChecker
): boolean {
	if (isNodeNamedDeclaration(node)) {
		const nodeSymbol = getNodeSymbol(node, typeChecker);
		if (nodeSymbol === null) {
			return false;
		}

		return rootFileExports.some((rootExport: ts.Symbol) => typesUsageEvaluator.isSymbolUsedBySymbol(nodeSymbol, rootExport));
	} else if (ts.isVariableStatement(node)) {
		return node.declarationList.declarations.some((declaration: ts.VariableDeclaration) => {
			return isNodeUsed(declaration, rootFileExports, typesUsageEvaluator, typeChecker);
		});
	}

	return false;
}

function shouldNodeBeImported(
	node: ts.NamedDeclaration,
	rootFileExports: ReadonlyArray<ts.Symbol>,
	typesUsageEvaluator: TypesUsageEvaluator,
	typeChecker: ts.TypeChecker,
	isDefaultLibrary: (sourceFile: ts.SourceFile) => boolean
): boolean {
	const nodeSymbol = getNodeSymbol(node, typeChecker);
	if (nodeSymbol === null) {
		return false;
	}

	const symbolDeclarations = getDeclarationsForSymbol(nodeSymbol);
	const isSymbolDeclaredInDefaultLibrary = symbolDeclarations.some(
		(declaration: ts.Declaration) => isDefaultLibrary(declaration.getSourceFile())
	);
	if (isSymbolDeclaredInDefaultLibrary) {
		// we shouldn't import a node declared in the default library (such dom, es2015)
		// yeah, actually we should check that node is declared only in the default lib
		// but it seems we can check that at least one declaration is from default lib
		// to treat the node as un-importable
		// because we can't re-export declared somewhere else node with declaration merging

		// also, if some lib file will not be added to the project
		// for example like it is described in the react declaration file (e.g. React Native)
		// then here we still have a bug with "importing global declaration from a package"
		// (see https://github.com/timocov/dts-bundle-generator/issues/71)
		// but I don't think it is a big problem for now
		// and it's possible that it will be fixed in https://github.com/timocov/dts-bundle-generator/issues/59
		return false;
	}

	return getExportedSymbolsUsingStatement(node, rootFileExports, typesUsageEvaluator, typeChecker).length !== 0;
}

function getExportedSymbolsUsingStatement(
	node: ts.NamedDeclaration,
	rootFileExports: ReadonlyArray<ts.Symbol>,
	typesUsageEvaluator: TypesUsageEvaluator,
	typeChecker: ts.TypeChecker
): ReadonlyArray<ts.Symbol> {
	const nodeSymbol = getNodeSymbol(node, typeChecker);
	if (nodeSymbol === null) {
		return [];
	}

	const symbolsUsingNode = typesUsageEvaluator.getSymbolsUsingSymbol(nodeSymbol);
	if (symbolsUsingNode === null) {
		throw new Error('Something went wrong - value cannot be null');
	}

	// we should import only symbols which are used in types directly
	return Array.from(symbolsUsingNode).filter((symbol: ts.Symbol) => {
		const symbolsDeclarations = getDeclarationsForSymbol(symbol);
		if (symbolsDeclarations.length === 0 || symbolsDeclarations.every(isDeclarationFromExternalModule)) {
			return false;
		}

		return rootFileExports.some((rootSymbol: ts.Symbol) => typesUsageEvaluator.isSymbolUsedBySymbol(symbol, rootSymbol));
	});
}

function isSourceFileDefaultLibrary(program: ts.Program, file: ts.SourceFile): boolean {
	interface CompatibilityProgramPart {
		// this method was introduced in TypeScript 2.6
		// but to the public API it was added only in TypeScript 3.0
		// so, to be compiled with TypeScript < 3.0 we need to have this hack
		isSourceFileDefaultLibrary(file: ts.SourceFile): boolean;
	}

	type CommonKeys = keyof (CompatibilityProgramPart | ts.Program);

	// if current ts.Program has isSourceFileDefaultLibrary method - then use it
	// if it does not have it yet - use fallback
	type CompatibleProgram = CommonKeys extends never ? ts.Program & CompatibilityProgramPart : ts.Program;

	// tslint:disable-next-line:no-unnecessary-type-assertion
	return (program as CompatibleProgram).isSourceFileDefaultLibrary(file);
}

function getNodeSymbol(node: ts.Node, typeChecker: ts.TypeChecker): ts.Symbol | null {
	const nodeName = (node as unknown as ts.NamedDeclaration).name;
	if (nodeName === undefined) {
		return null;
	}

	return getDeclarationNameSymbol(nodeName, typeChecker);
}

function getDeclarationNameSymbol(name: ts.DeclarationName, typeChecker: ts.TypeChecker): ts.Symbol | null {
	const symbol = typeChecker.getSymbolAtLocation(name);
	if (symbol === undefined) {
		return null;
	}

	return getActualSymbol(symbol, typeChecker);
}
