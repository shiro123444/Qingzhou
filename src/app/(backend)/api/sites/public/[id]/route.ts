import { SiteError, siteIdSchema } from '@/server/runtime/sites/contracts';
import { getSitesStore } from '@/server/runtime/sites/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!siteIdSchema.safeParse(id).success)
    return Response.json({ message: 'Site not found' }, { status: 404 });
  try {
    return Response.json(await getSitesStore().readPublic(id), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return Response.json(
      { message: 'Site not found' },
      { status: error instanceof SiteError ? error.status : 500 },
    );
  }
}
