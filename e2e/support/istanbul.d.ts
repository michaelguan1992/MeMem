// The istanbul packages that the e2e coverage step uses ship without TypeScript declarations, and no @types package
// exists for them. These declare only the calls that step makes. Their runtime is the installed package.
declare module 'istanbul-lib-coverage' {
  export interface CoverageMap {
    merge(data: object): void;
  }
  const libCoverage: { createCoverageMap(data?: object): CoverageMap };
  export default libCoverage;
}

declare module 'istanbul-lib-report' {
  const libReport: { createContext(options: { dir: string; coverageMap: unknown }): object };
  export default libReport;
}

declare module 'istanbul-reports' {
  const reports: { create(name: string, options?: object): { execute(context: object): void } };
  export default reports;
}
