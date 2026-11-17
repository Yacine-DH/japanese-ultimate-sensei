export function ReviewPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-100">Spaced Repetition Review (FSRS)</h1>
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-sm text-slate-400">
        Scene-based flashcard reviews will connect to <code>/reviews/due</code> and{' '}
        <code>/reviews</code> once S-3 and W-3 land.
      </div>
    </div>
  );
}
