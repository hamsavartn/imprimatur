import { ModelGateway, modelConfigFromEnv } from '@/lib/models';

export async function GET() {
  const cfg = modelConfigFromEnv();
  const gateway = new ModelGateway(cfg);
  return Response.json({
    provider: gateway.provider,
    confidentialMode: cfg.confidential,
    providerLabel:
      gateway.provider === 'gemini' ? 'Gemini (free tier)' :
      gateway.provider === 'glm' ? 'GLM (paid fallback)' :
      gateway.provider === 'local' ? 'local' :
      'none — deterministic lane only (confidential mode)',
  });
}
