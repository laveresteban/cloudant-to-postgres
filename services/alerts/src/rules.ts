/** One change from the migrator's GET /events feed. */
export interface FeedEvent {
  event_id: number;
  doc_id: string;
  rev: string;
  op: 'create' | 'update' | 'delete';
  body: Record<string, unknown>;
  created_at: string;
}

export interface Alert {
  event_id: number;
  rule: string;
  doc_id: string;
  message: string;
}

export interface RuleOptions {
  highValueThreshold: number;
}

/**
 * Turns one change into zero or more alerts. Tombstones have an empty body,
 * so rules that need the type key on the doc_id prefix instead.
 */
export function evaluate(event: FeedEvent, opts: RuleOptions): Alert[] {
  const alerts: Alert[] = [];
  const { event_id, doc_id } = event;

  if (event.op === 'create' && event.body.type === 'order') {
    const total = Number(event.body.total);
    if (total >= opts.highValueThreshold) {
      alerts.push({ event_id, rule: 'high_value_order', doc_id, message: `Order ${doc_id} placed for ${total}` });
    }
  }

  if (event.op === 'delete' && doc_id.startsWith('order:')) {
    alerts.push({ event_id, rule: 'order_deleted', doc_id, message: `Order ${doc_id} was deleted` });
  }

  return alerts;
}
