import type { AgentEvent, SessionView } from './contracts';

/** Shared immutable reducer: disk snapshots and live UI must interpret events identically. */
export function reduceAgentEvent(session: SessionView, event: AgentEvent): SessionView {
  if (session.id !== event.sessionId) return session;
  if (session.runId && session.runId !== event.runId && !(event.type === 'status' && event.status === 'running' && !['running', 'awaiting_approval'].includes(session.status))) return session;
  const at = new Date().toISOString();
  const next: SessionView = { ...session, messages: session.messages.map(m => ({ ...m, parts: m.parts?.map(p => ({ ...p })) })), tools: session.tools.map(t => ({ ...t })) };
  next.updatedAt = at; next.runId = event.runId;
  const message = 'messageId' in event ? next.messages.find(m => m.id === event.messageId) : undefined;
  switch (event.type) {
    case 'status': next.status = event.status; break;
    case 'progress': next.progress = event.progress; break;
    case 'session_file': next.piFile = event.file; break;
    case 'message_start':
      if (!message) next.messages.push({ id: event.messageId, role: 'assistant', text: '', createdAt: at, partial: true });
      break;
    case 'part_start':
      if (message && !message.parts?.some(p => p.index === event.index)) {
        (message.parts ??= []).push({ index: event.index, type: event.kind, text: '', startedAt: event.at, state: 'streaming' });
        message.parts.sort((a, b) => a.index - b.index);
      }
      break;
    case 'part_delta': {
      const part = message?.parts?.find(p => p.index === event.index);
      if (part) { part.text += event.delta; if (part.type === 'text') message!.text += event.delta; }
      break;
    }
    case 'part_end': {
      const part = message?.parts?.find(p => p.index === event.index);
      if (part) {
        part.endedAt = event.at; part.state = event.interrupted ? 'interrupted' : 'completed';
        if (event.text !== undefined) { part.text = event.text; if (part.type === 'text') message!.text = message!.parts!.filter(p => p.type === 'text').map(p => p.text).join(''); }
      }
      if (part?.type === 'thinking' && !part.text) message!.parts = message!.parts!.filter(p => p !== part);
      break;
    }
    case 'text_delta': if (message && !message.parts?.some(p => p.type === 'text')) message.text += event.delta; break;
    case 'message_end':
      if (message) { message.text = event.text; message.partial = false; }
      else next.messages.push({ id: event.messageId, role: 'assistant', text: event.text, createdAt: at });
      break;
    case 'tool_start': next.tools.push({ id: event.toolCallId, runId: event.runId, name: event.name, args: event.args, createdAt: at, status: 'running' }); break;
    case 'tool_result': {
      const tool = [...next.tools].reverse().find(t => t.id === event.toolCallId && t.runId === event.runId);
      if (tool) { tool.result = event.result; tool.isError = event.isError; tool.status = event.isError ? 'failed' : 'completed'; }
      break;
    }
    case 'approval': next.approval = event.approval; next.status = 'awaiting_approval'; break;
    case 'approval_resolved': if (next.approval?.id === event.approvalId) { delete next.approval; next.status = 'running'; } break;
    case 'error': next.error = event.message; break;
    case 'settled':
      next.status = event.status; next.error = event.error ?? next.error; delete next.approval; delete next.progress;
      for (const m of next.messages) {
        m.partial = false;
        for (const part of m.parts ?? []) if (part.state === 'streaming') { part.state = 'interrupted'; part.endedAt = at; }
      }
      for (const tool of next.tools) if (tool.status === 'running') { tool.status = 'failed'; tool.isError = true; tool.result ||= '运行已结束，工具没有确认结果。不会自动重试。'; }
      break;
  }
  return next;
}
