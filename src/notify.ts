export async function sendNotification(
  server: { call: (method: string, params?: unknown) => Promise<unknown> },
  message: string
): Promise<void> {
  await server.call('admin:sendNotification', {
    event: {
      event: 'IPQA 告警报告',
      time: new Date().toISOString(),
      emoji: '⚠️',
      message,
    },
  });
}
