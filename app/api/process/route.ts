/**
 * 视频处理 API：路由入口
 *
 * 该文件仅负责声明运行时，并将实际逻辑委托给 node-handler，
 * 避免在多处重复实现同样的业务流程。
 */

export const runtime = 'nodejs'

export { handleProcessPost as POST } from './node-handler'
