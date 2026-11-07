import { describe, expect, it } from "vitest";
import {
  arrangeCanvasRow,
  canvasPoint,
  fitCanvas,
  snapCanvasBoard,
  zoomCanvasAt,
} from "./canvas-geometry";

describe("design canvas geometry", () => {
  it("keeps the world point beneath a zoom anchor, including clamped zoom", () => {
    const camera = { x: -240, y: 64, zoom: 0.6 };
    const anchor = { x: 450, y: 280 };
    for (const zoom of [0.02, 0.8, 5]) {
      const next = zoomCanvasAt(camera, anchor, zoom);
      expect(canvasPoint(next, anchor)).toEqual(canvasPoint(camera, anchor));
      expect(next.zoom).toBeGreaterThanOrEqual(0.1);
      expect(next.zoom).toBeLessThanOrEqual(2);
    }
  });

  it("fits displaced long pages inside the usable viewport", () => {
    const boards = [
      { x: -1440, y: 120, width: 1440, height: 2400 },
      { x: 96, y: 0, width: 1440, height: 1800 },
    ];
    const camera = fitCanvas(boards, { width: 1100, height: 900 });
    for (const board of boards) {
      expect(camera.x + board.x * camera.zoom).toBeGreaterThanOrEqual(0);
      expect(camera.y + board.y * camera.zoom).toBeGreaterThanOrEqual(64);
      expect(
        camera.x + (board.x + board.width) * camera.zoom,
      ).toBeLessThanOrEqual(1100);
      expect(
        camera.y + (board.y + board.height) * camera.zoom,
      ).toBeLessThanOrEqual(900);
    }
  });

  it("arranges pages in blueprint order without depending on their loaded heights", () => {
    expect(arrangeCanvasRow(["detail", "home"], 1440)).toEqual({
      detail: { x: 0, y: 0 },
      home: { x: 1536, y: 0 },
    });
  });

  it.each([0.1, 0.4, 1, 2])(
    "snaps within eight screen pixels at zoom %s",
    (zoom) => {
      const peer = { id: "peer", x: 1000, y: 2000, width: 2000, height: 6000 };
      const moving = {
        id: "moving",
        x: 1000 + 7 / zoom,
        y: 2000 + 7 / zoom,
        width: 1400,
        height: 4170,
      };
      const result = snapCanvasBoard(moving, [peer], zoom);
      expect(result.position).toEqual({ x: 1000, y: 2000 });
      expect(result.guides).toHaveLength(2);
      // Use only the leading edges so an unrelated center cannot be a nearer match.
      const tiny = {
        id: "tiny",
        x: 1000 - 9 / zoom,
        y: 2000 - 9 / zoom,
        width: 0,
        height: 0,
      };
      expect(snapCanvasBoard(tiny, [peer], zoom).guides).toEqual([]);
    },
  );

  it("selects the nearest candidate independently on each axis", () => {
    const moving = { id: "moving", x: 1, y: 2, width: 100, height: 300 };
    const peers = [
      { id: "far", x: 7, y: 9, width: 100, height: 300 },
      { id: "near-x", x: 0, y: 1000, width: 100, height: 100 },
      { id: "near-y", x: 1000, y: 0, width: 100, height: 100 },
    ];
    const result = snapCanvasBoard(moving, peers, 1);
    expect(result.position).toEqual({ x: 0, y: 0 });
    expect(result.guides).toEqual([
      { axis: "x", coordinate: 0, start: 0, end: 1100 },
      { axis: "y", coordinate: 0, start: 0, end: 1100 },
    ]);
  });

  it("aligns centers and ignores the moving board itself", () => {
    const moving = { id: "moving", x: 76, y: 226, width: 50, height: 50 };
    const peer = { id: "peer", x: 0, y: 0, width: 200, height: 500 };
    expect(snapCanvasBoard(moving, [moving], 1)).toEqual({
      position: { x: 76, y: 226 },
      guides: [],
    });
    const result = snapCanvasBoard(moving, [moving, peer], 1);
    expect(result.position).toEqual({ x: 75, y: 225 });
    expect(result.guides.map((guide) => guide.coordinate)).toEqual([100, 250]);
  });

  it("resolves equal distances independently of peer input order", () => {
    const moving = { id: "moving", x: 100, y: 500, width: 100, height: 300 };
    const peers = [
      { id: "b", x: 104, y: 1000, width: 100, height: 300 },
      { id: "a", x: 96, y: 2000, width: 100, height: 300 },
    ];
    expect(snapCanvasBoard(moving, peers, 1)).toEqual(
      snapCanvasBoard(moving, [...peers].reverse(), 1),
    );
    expect(snapCanvasBoard(moving, peers, 1).position).toEqual({
      x: 96,
      y: 500,
    });
  });
});
