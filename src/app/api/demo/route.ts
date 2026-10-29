import { DRAFTS } from '@seed/meridian-flow';

/** Demo presets are static content: no auth, no database. */
export async function GET() {
  return Response.json({
    presets: DRAFTS.map((d) => ({ id: d.id, title: d.title, demonstrates: d.demonstrates, content: d.content })),
  });
}
