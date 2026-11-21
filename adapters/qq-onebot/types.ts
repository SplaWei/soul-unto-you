/**
 * QQ OneBot v11 适配器类型定义（零外部依赖 · Node.js 原生可擦除 TypeScript）。
 */

export interface QqGuardConfig {
  /** 允许互动的私聊 QQ 号白名单（默认空，fail-closed 拒绝未知陌生人） */
  allowedUsers: string[];
  /** 允许互动的 QQ 群号白名单（默认空，fail-closed） */
  allowedGroups: string[];
  /** 同一私聊对象最小回复间隔（毫秒，建议 2500-3000ms） */
  privateCooldownMs: number;
  /** 同一群聊最小回复间隔（毫秒，建议 4000ms+） */
  groupCooldownMs: number;
  /** 全局每分钟最大回复条数 */
  maxRepliesPerMinute: number;
  /** 全局每小时最大回复条数 */
  maxRepliesPerHour: number;
  /** 拟人随机延迟下限（毫秒） */
  replyDelayMinMs: number;
  /** 拟人随机延迟上限（毫秒） */
  replyDelayMaxMs: number;
  /** 单条 QQ 消息最大字符数，超出则分片发送 */
  maxReplyChars: number;
  /** 群聊是否必须 @机器人 或命中唤醒词才开口 */
  groupRequireAtOrWakeWord: boolean;
  /** 群聊唤醒词列表 */
  wakeWords: string[];
  /** 群内未触发唤醒时是否静默记录到灵魂经验流（不发消息，零风险） */
  observeUnmentionedGroupMessages: boolean;
  /** 防断线重连积压风暴：丢弃早于连接时刻 N 秒以上的历史消息 */
  maxMessageAgeSec: number;
  /** 启动前检测本地端口冲突（如旧桥接端口），发现占用即拒绝并发上线 */
  conflictCheckPorts: number[];
}

export interface QqVoiceConfig {
  /** 是否转发语音条（依赖中枢或本地 GPT-SoVITS :8765） */
  enabled: boolean;
  /** 发送语音时是否同时发送文字内容 */
  sendTextWithVoice: boolean;
  /** 可选：直接请求本地 GPT-SoVITS HTTP 地址 */
  directGsvUrl?: string;
  character?: string;
}

export interface QqOneBotEndpointConfig {
  wsUrl: string;
  wsAccessToken?: string;
  httpUrl?: string;
  httpAccessToken?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export interface QqAdapterConfig {
  soulHubUrl: string;
  apiToken?: string;
  perceptTimeoutMs?: number;
  bodyId: string;
  displayName: string;
  onebot: QqOneBotEndpointConfig;
  guard: QqGuardConfig;
  enableImageForward: boolean;
  stripMarkdown: boolean;
  voice: QqVoiceConfig;
  proactive: {
    enabled: boolean;
    targetUserId?: string;
  };
}

export interface OneBotSegment {
  type: string;
  data?: Record<string, unknown>;
}

export interface OneBotMessageEvent {
  post_type?: string;
  message_type?: 'private' | 'group' | string;
  sub_type?: string;
  message_id?: number | string;
  user_id?: number | string;
  group_id?: number | string;
  self_id?: number | string;
  time?: number;
  raw_message?: string;
  message?: string | OneBotSegment[];
  sender?: {
    user_id?: number | string;
    nickname?: string;
    card?: string;
  };
}

export interface ParsedQqMessage {
  text: string;
  isAtSelf: boolean;
  mentionedIds: string[];
  imageUrls: string[];
}
