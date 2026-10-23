"use client";

import { useEffect, useState, type ComponentType } from "react";

// Native web renders in the browser. Keeping its module out of the server
// render also avoids browser-only DOM helpers running in a Worker isolate.
export default function Page() {
  const [App, setApp] = useState<ComponentType | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    setFailed(false);
    import("../components/order/OrderApp")
      .then((module) => {
        if (!disposed) setApp(() => module.default);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [attempt]);
  if (App) return <App />;
  return (
    <main className="opening-shell" aria-live="polite">
      <strong>
        담다 <small>DAMDA</small>
      </strong>
      <p>
        {failed
          ? "화면을 불러오지 못했어요. 다시 시도해주세요."
          : "테이블을 준비하고 있어요."}
      </p>
      <p lang="en">
        {failed ? "Unable to load. Please try again." : "Preparing your table."}
      </p>
      {failed && (
        <button onClick={() => setAttempt((value) => value + 1)}>
          다시 시도 · Retry
        </button>
      )}
    </main>
  );
}
