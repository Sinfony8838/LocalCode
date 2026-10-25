import type { RunStatus } from '../shared/contracts';
import type { PetAnimation } from '../shared/pets';
export function petActivity(status: RunStatus): { animation: PetAnimation; label: string } {
  switch (status) {
    case 'running': return { animation: 'running', label: '正在思考与处理任务' };
    case 'awaiting_approval': return { animation: 'waiting', label: '有一条命令等你确认' };
    case 'completed': return { animation: 'review', label: '本轮任务已完成' };
    case 'failed': return { animation: 'failed', label: '任务遇到问题，点我查看' };
    case 'interrupted': return { animation: 'failed', label: '任务已停止' };
    default: return { animation: 'idle', label: '陪你在本地写代码' };
  }
}
export function lookDirection(dx: number, dy: number): number | undefined {
  if (Math.hypot(dx, dy) < 36) return undefined;
  return Math.round((Math.atan2(dx, -dy) * 180 / Math.PI + 360) / 22.5) % 16;
}
export function clampPetPosition(position: { x: number; y: number }, area: { x: number; y: number; width: number; height: number }, width: number, height: number) {
  return { x: Math.round(Math.max(area.x, Math.min(position.x, area.x + Math.max(0, area.width - width)))),
    y: Math.round(Math.max(area.y, Math.min(position.y, area.y + Math.max(0, area.height - height)))) };
}
