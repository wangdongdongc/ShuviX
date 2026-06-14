/**
 * [已废弃] 此文件已拆分为 DAO + Service 两层架构：
 *
 * DAO 层（纯数据访问）：
 *   - dao/database.ts     — DB 连接管理
 *   - dao/sessionDao.ts   — Session 表操作
 *   - dao/messageDao.ts   — Message 表操作
 *   - dao/settingsDao.ts  — Settings 表操作
 *
 * Service 层（业务逻辑）：
 *   - services/sessionService.ts
 *   - services/messageService.ts
 *   - services/settingsService.ts
 *
 * 类型定义：
 *   - types/index.ts
 *
 * 保留此文件仅为兼容性 re-export，新代码请直接引用上述模块。
 */
export type { Session, Message, Settings } from '../types'
export { databaseManager } from '../dao/database'
