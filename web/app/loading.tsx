export default function Loading() {
  return (
    <main className="flex min-h-[60vh] items-center justify-center p-6">
      <p role="status" className="flex items-center gap-3 text-lg font-bold text-[#083344]">
        <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-2 border-[#0891b2]/25 border-t-[#0891b2] motion-reduce:animate-none" />
        読み込み中…
      </p>
    </main>
  );
}
