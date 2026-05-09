export type ChatSettingsWriteWork = () => Promise<void>;

export type ChatSettingsWriteBarrier = {
  run(chatId: string, work: ChatSettingsWriteWork): Promise<void>;
  wait(chatId: string): Promise<void>;
  pendingCount(chatId: string): number;
};

export function createChatSettingsWriteBarrier(): ChatSettingsWriteBarrier {
  const pendingByChat = new Map<string, Set<Promise<void>>>();
  const tailByChat = new Map<string, Promise<void>>();

  function cleanup(
    chatId: string,
    promise: Promise<void>,
    tail: Promise<void>,
  ) {
    const pending = pendingByChat.get(chatId);
    if (pending) {
      pending.delete(promise);
      if (pending.size === 0) pendingByChat.delete(chatId);
    }
    if (!pendingByChat.has(chatId) && tailByChat.get(chatId) === tail) {
      tailByChat.delete(chatId);
    }
  }

  function run(chatId: string, work: ChatSettingsWriteWork) {
    const previous = tailByChat.get(chatId) ?? Promise.resolve();
    const promise = previous.catch(() => undefined).then(work);
    let pending = pendingByChat.get(chatId);
    if (!pending) {
      pending = new Set();
      pendingByChat.set(chatId, pending);
    }
    pending.add(promise);
    const tail = promise.catch(() => undefined);
    tailByChat.set(chatId, tail);
    promise.then(
      () => cleanup(chatId, promise, tail),
      () => cleanup(chatId, promise, tail),
    );
    return promise;
  }

  async function wait(chatId: string) {
    while (true) {
      const pending = pendingByChat.get(chatId);
      if (!pending || pending.size === 0) return;
      await Promise.allSettled([...pending]);
    }
  }

  function pendingCount(chatId: string) {
    return pendingByChat.get(chatId)?.size ?? 0;
  }

  return { run, wait, pendingCount };
}
