// Kept as raw ES2017 source: the desktop Parcel parser does not support newer syntax.
export default function installCaptureCanvasAdapter(runtime) {
  const toSvg = runtime.toSvg;
  function abortReason(signal) {
    return signal.reason !== null && signal.reason !== undefined
      ? signal.reason
      : new DOMException("Screenshot capture was cancelled.", "AbortError");
  }
  function screenshotError(stage, cause) {
    const detail =
      cause &&
      typeof cause === "object" &&
      "message" in cause &&
      typeof cause.message === "string"
        ? cause.message
        : "";
    return new Error(
      `Screenshot ${stage} failed${detail ? `: ${detail}` : "."}`,
    );
  }
  function prepareSvg(node, options) {
    const signal = options.signal;
    return new Promise((resolve, reject) => {
      function abort() {
        reject(abortReason(signal));
      }
      if (signal && signal.aborted) {
        abort();
        return;
      }
      if (signal) signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          if (signal && signal.aborted) throw abortReason(signal);
          return toSvg(node, options);
        })
        .then(resolve, (error) =>
          reject(
            signal && signal.aborted
              ? abortReason(signal)
              : screenshotError("SVG preparation", error),
          ),
        )
        .finally(() => {
          if (signal) signal.removeEventListener("abort", abort);
        });
    });
  }
  function loadImage(svg, signal) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      let settled = false;
      let decoding = false;
      const timer = setTimeout(
        () => fail(new Error("Screenshot image load/decode timed out.")),
        15000,
      );
      function cleanup() {
        clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
        if (signal) signal.removeEventListener("abort", abort);
      }
      function release() {
        cleanup();
        image.removeAttribute("src");
      }
      function fail(error) {
        if (settled) return;
        settled = true;
        release();
        reject(error);
      }
      function abort() {
        fail(abortReason(signal));
      }
      function ready() {
        if (settled) return;
        if (
          !image.complete ||
          image.naturalWidth <= 0 ||
          image.naturalHeight <= 0
        ) {
          fail(new Error("Screenshot image decoded without valid dimensions."));
          return;
        }
        settled = true;
        cleanup();
        resolve({ image, release });
      }
      image.onload = () => {
        if (settled || decoding) return;
        decoding = true;
        try {
          const decoded =
            typeof image.decode === "function"
              ? image.decode()
              : Promise.resolve();
          Promise.resolve(decoded).then(ready, (error) =>
            fail(screenshotError("image decode", error)),
          );
        } catch (error) {
          fail(screenshotError("image decode", error));
        }
      };
      image.onerror = () =>
        fail(new Error("Screenshot SVG image failed to load."));
      if (signal) signal.addEventListener("abort", abort, { once: true });
      if (signal && signal.aborted) {
        abort();
        return;
      }
      // toSvg embeds resources in a data URI. It needs no cross-origin mode.
      try {
        image.src = svg;
      } catch (error) {
        fail(screenshotError("image load", error));
      }
    });
  }
  runtime.toCanvas = async (node, options) => {
    const { canvasWidth: width, canvasHeight: height, signal } = options;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > 6000000 ||
      options.pixelRatio !== 1
    ) {
      throw new Error("Screenshot canvas dimensions are invalid.");
    }
    const svg = await prepareSvg(node, options);
    if (signal && signal.aborted) throw abortReason(signal);
    if (!svg.startsWith("data:image/svg+xml"))
      throw new Error("Screenshot renderer returned an invalid SVG image.");
    let loaded;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        loaded = await loadImage(svg, signal);
        break;
      } catch (error) {
        if (signal && signal.aborted) throw abortReason(signal);
        if (attempt === 1) throw error;
      }
    }
    if (!loaded) throw new Error("Screenshot image is unavailable.");
    try {
      if (signal && signal.aborted) throw abortReason(signal);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error("Screenshot canvas context is unavailable.");
      if (options.backgroundColor) {
        context.fillStyle = options.backgroundColor;
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(loaded.image, 0, 0, width, height);
      return canvas;
    } finally {
      loaded.release();
    }
  };
}
