// Kept as raw ES2017 source: the desktop Parcel parser does not support newer syntax.
export default function installCaptureCanvasAdapter(runtime, html2canvas) {
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
  const fallbackCanvas = async (node, options) => {
    const { canvasWidth: width, canvasHeight: height, signal } = options;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      (options.output !== "annotation" && width * height > 6000000) ||
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

  runtime.toCanvas = async (node, options) => {
    if (typeof html2canvas !== "function" || !options.region) {
      return fallbackCanvas(node, options);
    }
    const signal = options.signal;
    if (signal && signal.aborted) throw abortReason(signal);
    let container;
    let removedContainer;
    let canvas;
    let primaryStopped = false;
    function cleanup() {
      if (container && container !== removedContainer) {
        container.remove();
        removedContainer = container;
      }
      container = undefined;
    }
    function waitForRendering(rendering) {
      // html2canvas's imageTimeout does not bound iframe loading or fonts.ready.
      // Leave time for the SVG fallback before the host's capture deadline.
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(
          () => finish(new Error("Screenshot document rendering timed out.")),
          15000,
        );
        function abort() {
          finish(abortReason(signal));
        }
        function finish(error, result) {
          if (settled) {
            // The library cannot be cancelled; discard any late allocation.
            if (result) {
              result.width = 0;
              result.height = 0;
            }
            return;
          }
          settled = true;
          primaryStopped = true;
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve(result);
        }
        Promise.resolve(rendering).then(
          (result) => finish(null, result),
          (error) => finish(error),
        );
        if (signal) {
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }
      });
    }
    async function render() {
      try {
        const region = options.region;
        const ownerDocument = node.ownerDocument;
        const previousContainers = ownerDocument
          ? Array.from(
              ownerDocument.querySelectorAll("iframe.html2canvas-container"),
            )
          : [];
        // WebKit can leave a cloned lazy image's document permanently loading,
        // even though html2canvas changes the image to eager after cloneNode.
        // Set it before the synchronous clone, then restore the live document.
        const lazyImages = node.querySelectorAll
          ? Array.from(node.querySelectorAll("img"))
              .filter((image) => image.loading === "lazy")
              .map((image) => [image, image.getAttribute("loading")])
          : [];
        let rendering;
        try {
          lazyImages.forEach(([image]) =>
            image.setAttribute("loading", "eager"),
          );
          rendering = html2canvas(node, {
            windowWidth: options.windowWidth,
            windowHeight: options.windowHeight,
            scrollX: region.x,
            scrollY: region.y,
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
            scale: options.scale,
            useCORS: true,
            allowTaint: false,
            logging: false,
            removeContainer: false,
            ignoreElements: (element) =>
              element.hasAttribute("data-ob-design-overlay"),
            onclone: (clonedDocument) => {
              container = clonedDocument.defaultView.frameElement;
              if (primaryStopped) {
                cleanup();
                throw new Error("Screenshot document rendering has ended.");
              }
              if (signal && signal.aborted) throw abortReason(signal);
            },
          });
        } finally {
          lazyImages.forEach(([image, loading]) =>
            image.setAttribute("loading", loading),
          );
          // The library appends its iframe synchronously before returning its
          // promise. Remember it even when fonts fail before onclone runs.
          if (!container && ownerDocument) {
            const added = Array.from(
              ownerDocument.querySelectorAll("iframe.html2canvas-container"),
            ).filter((frame) => previousContainers.indexOf(frame) < 0);
            if (added.length === 1) container = added[0];
          }
        }
        canvas = await waitForRendering(rendering);
        if (signal && signal.aborted) {
          canvas.width = 0;
          canvas.height = 0;
          throw abortReason(signal);
        }
        if (
          canvas.width !== options.canvasWidth ||
          canvas.height !== options.canvasHeight ||
          !canvas.getContext("2d")
        ) {
          canvas.width = 0;
          canvas.height = 0;
          throw new Error("Screenshot canvas allocation failed.");
        }
        return canvas;
      } catch (error) {
        primaryStopped = true;
        if (signal && signal.aborted) throw abortReason(signal);
        cleanup();
        return fallbackCanvas(node, options);
      } finally {
        cleanup();
      }
    }
    return render();
  };
}
