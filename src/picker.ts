import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, SelectList, Text, matchesKey, type SelectItem } from "@earendil-works/pi-tui";

import { rankRepositories } from "./matcher.js";
import type { RepositoryIndexEntry } from "./index-store.js";

/**
 * A terminal-native searchable overlay. Input changes rerank the complete
 * local cache immediately; no GitHub request is made while the user types.
 */
export async function pickRepository(
  ctx: ExtensionCommandContext,
  repositories: readonly RepositoryIndexEntry[],
  initialQuery = "",
): Promise<RepositoryIndexEntry | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    throw new Error("Pi Flash's repository picker requires an interactive Pi session");
  }
  const byName = new Map(repositories.map((repository) => [repository.nameWithOwner, repository]));
  return ctx.ui.custom<RepositoryIndexEntry | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    const title = new Text(theme.fg("accent", theme.bold("Pi Flash repositories")), 1, 1);
    const hint = new Text("Type to filter · ↑/↓ select · Enter launch · Esc cancel", 1, 0);
    const input = new Input();
    input.setValue(initialQuery);
    let list = createList(input.getValue());

    const rebuild = () => {
      list = createList(input.getValue());
      container.clear();
      container.addChild(title);
      container.addChild(hint);
      container.addChild(input);
      container.addChild(list);
      container.invalidate();
      tui.requestRender();
    };

    const chooseCurrent = () => {
      const selected = list.getSelectedItem();
      done(selected ? byName.get(selected.value) : undefined);
    };
    input.onSubmit = chooseCurrent;
    input.onEscape = () => done(undefined);
    rebuild();

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
          list.handleInput(data);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          chooseCurrent();
          return;
        }
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          done(undefined);
          return;
        }
        input.handleInput(data);
        rebuild();
      },
    };

    function createList(query: string): SelectList {
      const items: SelectItem[] = rankRepositories(query, repositories).map((match) => ({
        value: match.repository.nameWithOwner,
        label: match.repository.nameWithOwner,
        description: match.repository.description || `default branch: ${match.repository.defaultBranch}`,
      }));
      const next = new SelectList(items, 10, getSelectListTheme());
      next.onSelect = (selected) => done(byName.get(selected.value));
      next.onCancel = () => done(undefined);
      return next;
    }
  }, { overlay: true, overlayOptions: { anchor: "center", width: 88, maxHeight: 24 } });
}
