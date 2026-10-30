/** Имена комнат WebSocket: всегда с префиксом магазина t:{tenantId}: (ТЗ 2.4.5). */
export const rooms = {
  tenant: (t: string) => `t:${t}:all`,
  user: (t: string, u: string) => `t:${t}:u:${u}`,
  store: (t: string, s: string) => `t:${t}:s:${s}`,
  session: (t: string, sid: string) => `t:${t}:sess:${sid}`,
  register: (t: string, r: string) => `t:${t}:reg:${r}`,
  scanner: (t: string, pair: string) => `t:${t}:scan:${pair}`,
};
