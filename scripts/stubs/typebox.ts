/**
 * 测试用桩：把 `typebox` 换成本文件（esbuild --alias）。
 * 只在 `makeDelegateParams()`（工具参数 schema）里用到，无头测试不调用它，给个惰性 Proxy 即可。
 */
export const Type: any = new Proxy({}, { get: () => () => ({}) });
