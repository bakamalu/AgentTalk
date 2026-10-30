module.exports = {
  host: '0.0.0.0',
  port: Number(process.env.KOISHI_PORT || 5140),
  plugins: {
    // 必须加载，否则 adapter 缺少 ctx.http 会启动失败
    http: {},
    // server 插件被 console 依赖无法移除，必须绑本地，避免开放 API 暴露公网
    server: {
      port: Number(process.env.KOISHI_PORT || 5140),
      host: '127.0.0.1',
    },
    // NapCat 是 ws 服务端(3001)，Koishi 用 ws 主动连接它
    'adapter-onebot': {
      protocol: 'ws',
      endpoint: process.env.NAPCAT_WS_ENDPOINT || 'ws://127.0.0.1:3001',
      selfId: process.env.NAPCAT_SELF_ID || '',
      token: '',
    },
    './plugins/deepseek': {
      apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY,
      apiBase: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      triggerKeyword: ['ai', 'bot', '机器人', 'deepseek'],
      // 人格/自称：改 BOT_SYSTEM_PROMPT 即可，无需动代码
      systemPrompt: process.env.BOT_SYSTEM_PROMPT || '',
      groupPolicy: 'at',
      // 运营方硬锁：群里只被 @ 才回复（playbook 08）
      mentionOnly: true,
      // 私聊默认只回白名单，不做全放行
      privatePolicy: 'whitelist',
      // 白名单来自环境变量：空 = 不设白名单（放行）；有值 = 仅名单内生效
      allowedUsers: process.env.BOT_ALLOWED_USERS || '',
      allowedGroups: process.env.BOT_ALLOWED_GROUPS || '',
      // 黑名单（优先于白名单，命中即拒）/ 敏感词 / 引用回复开关
      blacklistedUsers: process.env.BOT_BLACKLIST_USERS || '',
      blacklistedGroups: process.env.BOT_BLACKLIST_GROUPS || '',
      sensitiveWords: process.env.BOT_SENSITIVE_WORDS || '',
      // 拦截通知：1=当前会话发提示；空=仅记日志
      sensitiveNotify: process.env.BOT_SENSITIVE_NOTIFY || '',
      quoteReply: process.env.BOT_QUOTE_REPLY || '',
      // 状态目录（历史/用量落盘）
      stateDir: process.env.BOT_STATE_DIR || '',
      // QQ 内管理员（特权指令）：空 = 无管理员；有值 = 仅名单内
      adminUsers: process.env.BOT_ADMIN_USERS || '',
      // 管理员群聊特权开关：空/0 = 仅私聊生效；1 = 群里 @机器人 也能用
      adminGroup: process.env.BOT_ADMIN_GROUP || '',
      maxTurns: 8,
      // 频率闸与分段（playbook 10）
      ratePerMinute: 6,
      minIntervalMs: 1500,
      splitLimit: 500,
      splitMaxParts: 3,
      requestTimeoutMs: 60000,
    },
    console: {},
  },
};
