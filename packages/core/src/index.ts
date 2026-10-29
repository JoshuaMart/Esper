export {
  Advisories,
  type Advisory,
  type AdvisoryImport,
  type AdvisoryLink,
  type AdvisoryReport,
  type AdvisorySource,
  type AdvisoryState,
  advisoryLayer,
  advisoryStates,
  fixCommits,
  importAdvisories,
  type LinkContext,
  type Linked,
  linkAdvisory,
  type OsvEntry,
  type OsvRecording,
  osvSource,
  type Package,
  type PlacedLink,
  type Precision,
  placeLinks,
  precisions,
  recordedSource,
  type Severity,
  type StoredAdvisory,
  severities,
  snapshotVersion,
  stateOn,
} from './advisories.ts'
export {
  type Analysis,
  AnalysisError,
  type Analyzer,
  analyzerSource,
  analyzersDir,
  hashFolder,
  importAnalysis,
  loadAnalyzers,
  type Manifest,
  type Place,
  parseManifest,
  type Referent,
} from './analyzer.ts'
export * from './claims.ts'
export { type Detection, detectProfile } from './detect.ts'
export {
  type AnalyzerInput,
  type AnalyzerRunner,
  analyzerImage,
  cacheVolume,
  dockerAvailable,
  dockerRunner,
} from './docker.ts'
export {
  addEntries,
  type Callee,
  joinPath,
  type Member,
  normalisePattern,
  type Route,
} from './entries.ts'
export { EsperError, NotFound } from './errors.ts'
export {
  defaultPackageName,
  extractGo,
  type GoFile,
  type GoModuleRoot,
  GoProgram,
  modulePath,
} from './go.ts'
export { go, goImports, indexGo, parseGoMod } from './go-index.ts'
export * from './graph.ts'
export { Home, homeDir, type Project, profilesDir } from './home.ts'
export type { CallStats, IndexStats, Language, Module } from './language.ts'
export { languageNamed, languages } from './languages.ts'
export { type Library, loadLibrary } from './library.ts'
export * from './notes.ts'
export { defineGrammar, loadLanguage, loadQuery, parse } from './parser.ts'
export * from './profile.ts'
export { type PyFile, PyProgram, type PyType, typeSymbol as pyTypeSymbol } from './py.ts'
export { indexPy, python } from './py-index.ts'
export { parseToml } from './py-modules.ts'
export { declRef, externalRef, fingerprint, hashText, Names } from './refs.ts'
export {
  type NewSnapshot,
  type SnapshotCounts,
  type SnapshotInfo,
  Store,
  textLines,
} from './store.ts'
export {
  changedLines,
  classify,
  languageOf,
  materialise,
  readFolder,
  readRef,
  remoteRepositories,
  repositoryOf,
  type TargetFile,
  type TargetSnapshot,
} from './target.ts'
export { type TsFile, TsProgram, type TsType, typeSymbol } from './ts.ts'
export { indexTs, typescript } from './ts-index.ts'
export { parseJsonc, Resolver } from './ts-modules.ts'
export { compareVersions, cvss3Score, parseVersion, type Range, versionState } from './versions.ts'
export {
  diffEntries,
  type EntryChange,
  type EntryFilter,
  type EntrySummary,
  type PathStep,
  SnapshotView,
  type Step,
} from './view.ts'
