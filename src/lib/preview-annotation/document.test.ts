import { describe, expect, it } from "vitest";
import {
  annotationCrop,
  annotationPoint,
  commitAnnotation,
  createAnnotationHistory,
  redoAnnotation,
  undoAnnotation,
  type AnnotationMark,
} from "./document";

const mark: AnnotationMark = {
  tool: "arrow",
  start: { x: 10, y: 20 },
  end: { x: 90, y: 100 },
  color: "#ef4444",
  width: 3,
};

describe("annotation document", () => {
  it("maps displayed pointer coordinates to image pixels and clamps captured drags", () => {
    const bounds = { left: 10, top: 20, width: 300, height: 200 };
    const size = { width: 900, height: 600 };
    expect(annotationPoint({ x: 160, y: 120 }, bounds, size)).toEqual({
      x: 450,
      y: 300,
    });
    expect(annotationPoint({ x: -10, y: 500 }, bounds, size)).toEqual({
      x: 0,
      y: 600,
    });
  });

  it("normalizes reverse drags to integer crop pixels without exceeding the image", () => {
    expect(
      annotationCrop(
        { x: 190.2, y: 150.4 },
        { x: 30.7, y: 40.1 },
        { width: 200, height: 160 },
      ),
    ).toEqual({ x: 30, y: 40, width: 161, height: 111 });
    expect(
      annotationCrop(
        { x: -20, y: -10 },
        { x: 300, y: 400 },
        { width: 200, height: 160 },
      ),
    ).toEqual({ x: 0, y: 0, width: 200, height: 160 });
    expect(
      annotationCrop(
        { x: 40, y: 10 },
        { x: 40, y: 100 },
        { width: 200, height: 160 },
      ),
    ).toBeNull();
  });

  it("undoes marks, crop changes and clear, and discards redo after another edit", () => {
    const empty = createAnnotationHistory();
    const drawn = commitAnnotation(empty, { marks: [mark], crop: null });
    const crop = { x: 10, y: 10, width: 100, height: 90 };
    const cropped = commitAnnotation(drawn, { marks: [mark], crop });
    const cleared = commitAnnotation(cropped, { marks: [], crop: null });
    expect(undoAnnotation(cleared).present).toEqual(cropped.present);
    expect(undoAnnotation(undoAnnotation(cropped)).present).toEqual(
      empty.present,
    );
    expect(redoAnnotation(undoAnnotation(cropped)).present).toEqual(
      cropped.present,
    );
    const newEdit = commitAnnotation(undoAnnotation(cropped), {
      marks: [],
      crop: null,
    });
    expect(newEdit.future).toHaveLength(0);
    expect(redoAnnotation(newEdit)).toBe(newEdit);
    expect(undoAnnotation(empty)).toBe(empty);
  });
});
