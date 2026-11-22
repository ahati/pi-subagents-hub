import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SettingItem,
  SettingsList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { CUSTOM_HUB_BACKGROUND } from "../hub-background.js";
import {
  NUMERIC_SETTINGS_IDS,
  SETTINGS_DESCRIPTORS,
  SETTINGS_DESCRIPTORS_BY_ID,
  type SettingsMenuDeps,
  TEXT_SETTINGS_IDS,
} from "./settings-descriptors.js";

export type { SettingsMenuDeps };

/**
 * The row `SettingsList` would act on. The list keeps its cursor private, and
 * its filter rewrites the rows under it: applying a query resets
 * `selectedIndex` to 0, so an index tracked outside the list goes stale as soon
 * as the user types. Read the list's own pair instead.
 */
function selectedSetting(list: SettingsList): SettingItem | undefined {
  const state = list as unknown as {
    selectedIndex?: number;
    filteredItems?: SettingItem[];
  };
  return state.filteredItems?.[state.selectedIndex ?? 0];
}

export async function showSettings(ctx: ExtensionCommandContext, deps: SettingsMenuDeps): Promise<void> {
  function buildItems(): SettingItem[] {
    return SETTINGS_DESCRIPTORS.map((desc) => {
      const cur = desc.getCurrent(deps);
      const vals = desc.getValues ? desc.getValues(deps) : (desc.isNumeric ? [cur] : ["on", "off"]);
      const description = typeof desc.description === "function" ? desc.description(deps) : desc.description;
      return {
        id: desc.id,
        label: desc.label,
        description,
        currentValue: cur,
        values: [...vals],
      };
    });
  }

  function applyValue(id: string, value: string) {
    const descriptor = SETTINGS_DESCRIPTORS_BY_ID.get(id);
    descriptor?.apply(value, ctx, deps);
  }

  let list: SettingsList;

  const result = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
    const items = buildItems();

    list = new SettingsList(
      items,
      items.length + 2,
      getSettingsListTheme(),
      (id, newValue) => {
        // A text row's last choice leaves the list so a prompt can take over.
        if (TEXT_SETTINGS_IDS.has(id) && newValue === CUSTOM_HUB_BACKGROUND) {
          done(id);
          return;
        }
        applyValue(id, newValue);
      },
      () => done(undefined as undefined),
      { enableSearch: true },
    );

    const container = new Container();
    container.addChild(new Text("⚙  Subagent Settings", 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        const selected = selectedSetting(list);
        if (matchesKey(data, Key.enter) && selected && NUMERIC_SETTINGS_IDS.has(selected.id)) {
          done(selected.id);
          return;
        }
        list.handleInput?.(data);
      },
    };
  });

  if (result && NUMERIC_SETTINGS_IDS.has(result)) {
    const descriptor = SETTINGS_DESCRIPTORS_BY_ID.get(result);
    const current = descriptor ? descriptor.getCurrent(deps) : "";
    const label = descriptor?.numericPromptLabel ?? `${descriptor?.label ?? result}:`;

    let input: string | undefined = await ctx.ui.input(label, current);
    while (input != null) {
      const trimmed = input.trim();
      const n = Number(trimmed);
      if (trimmed !== "" && Number.isInteger(n)) {
        applyValue(result, String(n));
        await showSettings(ctx, deps);
        return;
      }
      input = await ctx.ui.input(label, trimmed);
    }
  }

  if (result && TEXT_SETTINGS_IDS.has(result)) {
    const descriptor = SETTINGS_DESCRIPTORS_BY_ID.get(result);
    const current = descriptor ? descriptor.getCurrent(deps) : "";
    const label = descriptor?.textPromptLabel ?? `${descriptor?.label ?? result}:`;

    let input: string | undefined = await ctx.ui.input(label, current);
    while (input != null) {
      const trimmed = input.trim();
      const parsed = descriptor?.parseText?.(trimmed);
      if (parsed !== undefined) {
        applyValue(result, parsed);
        await showSettings(ctx, deps);
        return;
      }
      input = await ctx.ui.input(label, trimmed);
    }
  }
}
