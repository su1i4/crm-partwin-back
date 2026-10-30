import { Injectable } from '@nestjs/common';
import { PostingContext } from './handlers/handler.types';

/**
 * Расширения проведения из других модулей (закупки: заказ, долг поставщику, заявки) — в той же транзакции.
 * beforePost — после проверок обработчика, до движений; afterPost — после движений; afterUnpost — после сторно
 * (в том числе при перепроведении, opts.forRepost = true).
 */
export interface DocumentHook {
  beforePost?(ctx: PostingContext): Promise<void>;
  afterPost?(ctx: PostingContext): Promise<void>;
  afterUnpost?(ctx: PostingContext, opts: { forRepost: boolean }): Promise<void>;
}

@Injectable()
export class DocumentHooks {
  private readonly hooks = new Map<string, DocumentHook[]>();

  on(type: string, hook: DocumentHook) {
    this.hooks.set(type, [...(this.hooks.get(type) ?? []), hook]);
  }

  async beforePost(ctx: PostingContext) {
    for (const h of this.hooks.get(ctx.doc.type) ?? []) await h.beforePost?.(ctx);
  }

  async afterPost(ctx: PostingContext) {
    for (const h of this.hooks.get(ctx.doc.type) ?? []) await h.afterPost?.(ctx);
  }

  async afterUnpost(ctx: PostingContext, forRepost: boolean) {
    for (const h of this.hooks.get(ctx.doc.type) ?? []) await h.afterUnpost?.(ctx, { forRepost });
  }
}
