export async function sendNotification(
  server: { call: (method: string, params?: unknown) => Promise<unknown> },
  message: string
): Promise<void> {
  await server.call('admin:sendNotification', {
    event: {
      event: 'IPQAAlertReport',
      time: new Date().toISOString(),
      emoji: '⚠️',
      message,
    },
  });
}
