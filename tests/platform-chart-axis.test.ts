// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrintThroughputChart, type OverviewHourlyPoint } from "../src/components/platform/overview-charts";
import { formatNumber, formatTime } from "../src/i18n/format";
import { DEFAULT_LOCALE } from "../src/i18n/config";

function renderChart(length: number) {
  const data: OverviewHourlyPoint[] = Array.from({ length }, (_, index) => ({
    bucket: new Date(Date.UTC(2026, 9, 14, index)).toISOString(),
    total: index + 1,
    success: index,
    failed: 1,
    queued: 0,
    inFlight: 0,
    expired: 0,
  }));
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(PrintThroughputChart, { data }));
  const svg = host.querySelector("svg")!;
  const axis = svg.nextElementSibling!;
  const width = Number(svg.getAttribute("viewBox")!.split(" ")[2]);
  return { data, svg, width, labels: [...axis.querySelectorAll<HTMLSpanElement>("span")] };
}

describe("Platform chart time labels match actual plotted data", () => {
  it.each([
    { length: 27, indices: [0, 4, 8, 12, 16, 20, 24, 26] },
    { length: 29, indices: [0, 4, 8, 12, 16, 20, 24, 28] },
  ])("keeps irregular $length-point axis labels aligned with their SVG points", ({ length, indices }) => {
    const { data, svg, width, labels } = renderChart(length);
    const points = [...svg.querySelectorAll("circle")];
    expect(points).toHaveLength(length);
    points.forEach((point, index) => {
      const title = point.querySelector("title")?.textContent ?? "";
      expect(title).toContain(formatTime(data[index].bucket, DEFAULT_LOCALE));
      expect(title).toContain(formatNumber(data[index].total, DEFAULT_LOCALE));
    });
    expect(labels).toHaveLength(indices.length);
    indices.forEach((dataIndex, labelIndex) => {
      const actualPointPercent = Number(points[dataIndex].getAttribute("cx")) / width * 100;
      expect(Number.parseFloat(labels[labelIndex].style.left)).toBeCloseTo(actualPointPercent, 8);
    });
    expect(labels[0].classList.contains("-translate-x-full")).toBe(false);
    expect(labels.at(-1)!.classList.contains("-translate-x-full")).toBe(true);
  });

  it("marks sparse edge and safe midpoint captions without changing their plotted coordinates", () => {
    const { svg, width, labels } = renderChart(29);
    const points = [...svg.querySelectorAll("circle")];
    const sparse = labels.filter((label) => label.dataset.axisCaption !== "hidden");
    expect(sparse).toHaveLength(3);
    expect(sparse.map((label) => label.dataset.axisCaption)).toEqual(["edge", "middle", "edge"]);
    [0, 16, 28].forEach((dataIndex, labelIndex) => {
      expect(Number.parseFloat(sparse[labelIndex].style.left))
        .toBeCloseTo(Number(points[dataIndex].getAttribute("cx")) / width * 100, 8);
    });
    expect(Number.parseFloat(sparse[1].style.left)).not.toBeCloseTo(50);
    // A responsive intrinsic SVG width keeps the HTML coordinate space equal
    // to the plot width, rather than adding horizontal viewBox letterboxing.
    expect(svg.classList.contains("h-auto")).toBe(true);
  });

  it("marks an unsafe near-edge midpoint as hidden while retaining its data point and timestamp", () => {
    const { data, svg, labels } = renderChart(6);
    const edges = labels.filter((label) => label.dataset.axisCaption === "edge");
    expect(edges).toHaveLength(2);
    expect(edges.map((label) => Number.parseFloat(label.style.left))).toEqual([0, 100]);
    // Non-caption points keep their full existing hover timestamp/count.
    expect(labels).toHaveLength(3);
    expect(labels[1].dataset.axisCaption).toBe("hidden");
    const title = svg.querySelectorAll("circle")[4].querySelector("title")!.textContent!;
    expect(title).toContain(formatTime(data[4].bucket, DEFAULT_LOCALE));
    expect(title).toContain(formatNumber(data[4].total, DEFAULT_LOCALE));
  });

  it("centers a singleton label on its sole plotted point and leaves empty data empty", () => {
    const single = renderChart(1);
    expect(single.labels).toHaveLength(1);
    expect(Number.parseFloat(single.labels[0].style.left))
      .toBe(Number(single.svg.querySelector("circle")!.getAttribute("cx")) / single.width * 100);
    expect(single.labels[0].classList.contains("-translate-x-1/2")).toBe(true);
    expect(single.labels[0].dataset.axisCaption).toBe("edge");
    expect(renderChart(0).labels).toHaveLength(0);
  });
});
