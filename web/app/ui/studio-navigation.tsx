"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavigationIconName = "avatar" | "voice" | "movie";

const NAVIGATION_ITEMS: ReadonlyArray<{
  href: string;
  label: string;
  icon: NavigationIconName;
}> = [
  { href: "/avatar", label: "Avatar", icon: "avatar" },
  { href: "/voice", label: "Voice", icon: "voice" },
  { href: "/movie", label: "Movie", icon: "movie" },
];

function NavigationIcon({ name }: { name: NavigationIconName }) {
  if (name === "voice") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-7 w-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="8" y="3" width="8" height="12" rx="4" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
      </svg>
    );
  }

  if (name === "movie") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-7 w-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="6" width="18" height="14" rx="2" />
        <path d="m3 10 4-4m2 4 4-4m2 4 4-4" />
        <path d="m10 13 5 2.5-5 2.5v-5Z" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-7 w-7"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M5 21a7 7 0 0 1 14 0" />
    </svg>
  );
}

function isActivePath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function StudioNavigation() {
  const pathname = usePathname();

  return (
    <>
      <aside
        aria-label="スタジオメニュー"
        className="fixed inset-y-0 left-0 z-50 hidden w-28 flex-col border-r-4 border-[#22d3ee] bg-[#fffdf5] md:flex"
      >
        <div className="flex h-24 shrink-0 items-center justify-center border-b border-black/10">
          <span className="rounded-full bg-[#ffd84d] px-3 py-1 text-[11px] font-black tracking-[0.18em] text-[#513a00]">
            MENU
          </span>
        </div>

        <nav className="flex flex-col gap-3 p-3" aria-label="制作機能">
          {NAVIGATION_ITEMS.map((item) => {
            const isActive = isActivePath(pathname, item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-2xl border-2 px-2 py-3 text-xs font-black transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] ${
                  isActive
                    ? "border-[#0891b2] bg-[#22d3ee] text-[#083344] shadow-[0_5px_0_#0891b2]"
                    : "border-transparent bg-white text-[#47616e] hover:border-[#22d3ee] hover:bg-[#e6faff]"
                }`}
              >
                <NavigationIcon name={item.icon} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto flex justify-center gap-1.5 pb-6" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-[#22d3ee]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#ffd84d]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#ef4444]" />
        </div>
      </aside>

      <nav
        aria-label="スタジオメニュー"
        className="fixed right-3 bottom-3 left-3 z-50 grid grid-cols-3 gap-1 rounded-[22px] border-2 border-[#0891b2] bg-white/95 p-1.5 shadow-[0_8px_30px_rgba(8,145,178,0.22)] backdrop-blur md:hidden"
      >
        {NAVIGATION_ITEMS.map((item) => {
          const isActive = isActivePath(pathname, item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={`flex min-h-14 items-center justify-center gap-2 rounded-2xl px-2 py-2 text-xs font-black transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0891b2] ${
                isActive
                  ? "bg-[#22d3ee] text-[#083344]"
                  : "text-[#47616e] hover:bg-[#e6faff]"
              }`}
            >
              <span className="[&>svg]:h-6 [&>svg]:w-6">
                <NavigationIcon name={item.icon} />
              </span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
