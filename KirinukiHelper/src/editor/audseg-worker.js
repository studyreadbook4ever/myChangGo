import { segmentAudSegPcm } from "./audseg.js";

self.addEventListener("message", (event) => {
  const requestId = String(event.data?.requestId || "");
  if (!requestId) {
    return;
  }
  try {
    const result = segmentAudSegPcm(event.data.samples, {
      sampleRateHz: Number(event.data.sampleRateHz)
    });
    self.postMessage({ requestId, ok: true, result });
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: {
        name: String(error?.name || "Error").slice(0, 80),
        message: String(error?.message || "AudSeg 분석에 실패했습니다.")
          .slice(0, 1_000)
      }
    });
  }
});
