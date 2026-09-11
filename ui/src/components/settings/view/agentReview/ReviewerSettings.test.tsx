// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReviewerSettings } from "./index";
import { rewriteProviderRefs, clearSubagentDefaultForRemovedModel, clearSubagentDefaultForRemovedProvider } from "../modelPool/utils/providerRefs";
import type { PilotDeckConfig } from "../modelPool/types";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../../../hooks/usePilotDeckConfig", () => ({ usePilotDeckConfig: () => ({}) }));
afterEach(cleanup);
const config: PilotDeckConfig = { agent: { model: "main/model", subagents: { default: "main/worker" } }, model: { providers: { main: { models: { model: {}, worker: {}, judge: {} } } } } };

it("defaults to the main Agent and lets users select or clear a separate reviewer", () => {
  const onChange = vi.fn();
  const { rerender } = render(<ReviewerSettings config={config} onChange={onChange} />);
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "main/judge" } });
  const custom = onChange.mock.calls[0][0];
  expect(custom.agent.acceptanceReview.model).toBe("main/judge");
  expect(custom.agent.subagents.default).toBe("main/worker");
  rerender(<ReviewerSettings config={custom} onChange={onChange} />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
  expect(onChange.mock.calls[1][0].agent.acceptanceReview.model).toBeUndefined();
});

it("persists disabling and hides model controls", () => {
  const onChange = vi.fn();
  const { rerender } = render(<ReviewerSettings config={config} onChange={onChange} />);
  fireEvent.click(screen.getByRole("switch"));
  const next = onChange.mock.calls[0][0];
  expect(next.agent.acceptanceReview.enabled).toBe(false);
  rerender(<ReviewerSettings config={next} onChange={onChange} />);
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("renames reviewer providers and returns to inheritance on model/provider removal", () => {
  const custom = { ...config, agent: { ...config.agent, acceptanceReview: { model: "main/judge" } } };
  expect(rewriteProviderRefs(custom, "main", "renamed").agent?.acceptanceReview?.model).toBe("renamed/judge");
  expect(clearSubagentDefaultForRemovedModel(custom, "main", "judge").agent?.acceptanceReview?.model).toBeUndefined();
  expect(clearSubagentDefaultForRemovedProvider(custom, "main").agent?.acceptanceReview?.model).toBeUndefined();
  expect(clearSubagentDefaultForRemovedModel(custom, "main", "worker").agent?.acceptanceReview?.model).toBe("main/judge");
});
