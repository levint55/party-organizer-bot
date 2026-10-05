import { Container } from '@cloudflare/containers';

const INSTANCE = 'party-organizer';

export class BotContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '30m';
  enableInternet = true;
}

interface Env {
  BOT_CONTAINER: DurableObjectNamespace<BotContainer>;
  DISCORD_TOKEN: string;
  DISCORD_CLIENT_ID: string;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_SERVICE_ACCOUNT_JSON: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const container = await wake(env);
    const path = new URL(request.url).pathname;
    if (path === '/health') {
      return container.fetch(new Request('http://container/health'));
    }
    return new Response('Party Organizer is running.');
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const container = await wake(env);
    await container.fetch(new Request('http://container/health'));
  },
};

async function wake(env: Env): Promise<DurableObjectStub<BotContainer>> {
  const container = env.BOT_CONTAINER.getByName(INSTANCE);
  await container.startAndWaitForPorts({
    ports: [8080],
    startOptions: {
      enableInternet: true,
      envVars: {
        PORT: '8080',
        DISCORD_TOKEN: env.DISCORD_TOKEN,
        DISCORD_CLIENT_ID: env.DISCORD_CLIENT_ID,
        FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID,
        FIREBASE_SERVICE_ACCOUNT_JSON: env.FIREBASE_SERVICE_ACCOUNT_JSON,
      },
    },
    cancellationOptions: {
      portReadyTimeoutMS: 120_000,
    },
  });
  return container;
}
