/**
 * 会话重绑命令：/switch — 把当前 QQ 对端重绑到指定已有会话
 *
 * 语义 = 宿主 rebind_qq_channel 的 QQ 侧等价物：
 *   - 无参数：列出本进程可见的 top-level 会话（含当前标记），点击即切换；
 *   - 有参数：/switch <sessionId> 直接重绑到指定会话（sessionPersistence 里已存在的）。
 *
 * 渠道信息这里不涉及 —— 渠道（c2c/group）由 session-peers.json 的 scope 权威承载，
 * 不往会话 source 写任何戳。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer, sendMarkdownChunked } from '../shared/index.ts';

const MAX_LIST = 12;

export function switchCommand({ manager, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'switch',
    category: 'agent',
    description: '切换当前会话（用法: /switch [sessionId]）',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const args = (cmdCtx.command?.raw ?? '').trim();

      // 无参数：列出可切换的会话
      if (!args) {
        const sessions = await manager.listSwitchableSessions(scope, peerId);
        if (sessions.length === 0) {
          return '当前无可切换的会话（会话持久化服务不可用或无 top-level 会话）。';
        }

        const lines: string[] = ['### 🔀 切换会话', ''];
        for (const s of sessions.slice(0, MAX_LIST)) {
          const shortId = s.sessionId.slice(0, 8);
          const when = formatWhen(s.createdAt);
          const cwdTag = s.cwd ? ` · ${basename(s.cwd)}` : '';
          const mark = s.isCurrent ? ' ✅ 当前' : '';
          lines.push(
            `<qqbot-cmd-input text="/switch ${s.sessionId}" show="/switch ${shortId}${cwdTag}${mark}"/>`,
          );
          lines.push(`└ ${when}${cwdTag}${mark}`);
        }
        if (sessions.length > MAX_LIST) {
          lines.push('', `（仅显示最近 ${MAX_LIST} 个，共 ${sessions.length} 个）`);
        }
        lines.push('', '手动指定: `/switch <sessionId>`');

        await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
        return { kind: 'noop' as const };
      }

      // 有参数：重绑到指定 sessionId
      const outcome = await manager.switchSession(scope, peerId, args);
      if (!outcome.ok) {
        switch (outcome.reason) {
          case 'not-found':
            return `❌ 会话 ${args} 不存在，无法切换。\n发 /switch 查看可切换的会话列表。`;
          default:
            return `❌ 切换失败: ${outcome.message ?? '未知错误'}`;
        }
      }

      return `✅ 已切换会话: ${args.slice(0, 8)}…\n下一条消息将进入该会话。`;
    },
  };
}

/** 相对时间（简洁展示） */
function formatWhen(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '未知时间';
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}

/** 路径 basename（跨平台） */
function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}