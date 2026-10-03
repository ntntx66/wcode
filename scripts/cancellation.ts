// Keep signal handlers installed until the caller has awaited its cleanup.
export async function withCancellation(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Smoke test interrupted (SIGINT)'));
  const terminate = () => controller.abort(new Error('Smoke test interrupted (SIGTERM)'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    await action(controller.signal);
    controller.signal.throwIfAborted();
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
