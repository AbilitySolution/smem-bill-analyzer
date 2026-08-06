import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const { data } = await supabase.auth.getUser();
  const isPublic =
    request.nextUrl.pathname === "/" ||
    request.nextUrl.pathname.startsWith("/login") ||
    request.nextUrl.pathname.startsWith("/accueil") ||
    request.nextUrl.pathname.startsWith("/depot/") ||
    // Les tâches planifiées s'authentifient par un secret partagé (en-tête Bearer),
    // pas par une session Supabase : sans cette exception, le middleware les
    // redirigerait vers /login et elles ne s'exécuteraient jamais. Chaque route
    // exemptée ici DOIT vérifier CRON_SECRET elle-même.
    request.nextUrl.pathname.startsWith("/api/cron/") ||
    // Auto-save : appelée par le Cron Vercel (Bearer CRON_SECRET, pas de cookie de
    // session) ET par le navigateur (session). La route distingue les deux elle-même
    // et échoue fermée sans secret.
    request.nextUrl.pathname === "/api/document-jobs/auto-save";

  if (!data.user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
