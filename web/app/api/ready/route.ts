export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ service: "chibichara-studio", ready: true }, {
    headers: {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
