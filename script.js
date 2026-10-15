(() => {
  "use strict";

  const view = document.querySelector("[data-view]");
  if (!view) return;

  const API = "./_kandev/v1";

  async function fetchJson(path) {
    const response = await fetch(path);
    if (!response.ok) {
      let code = response.status;
      try {
        const body = await response.json();
        if (body && body.error) code = body.error;
      } catch (_) {
        /* ignore parse failure, keep status code */
      }
      throw new Error(`${path} failed (${code})`);
    }
    return response.json();
  }

  async function fetchAllPages(basePath, limit) {
    const items = [];
    let cursor = null;
    for (;;) {
      const params = new URLSearchParams();
      if (limit) params.set("limit", String(limit));
      if (cursor) params.set("cursor", cursor);
      const query = params.toString();
      const page = await fetchJson(query ? `${basePath}?${query}` : basePath);
      items.push(...(page.items || []));
      cursor = page.page_info && page.page_info.next_cursor;
      if (!cursor) break;
    }
    return items;
  }

  function formatTimestamp(iso) {
    try {
      return new Date(iso).toLocaleString();
    } catch (_) {
      return iso;
    }
  }

  function stepLabel(stepMap, stepId) {
    if (!stepId) return "Created";
    const step = stepMap.get(stepId);
    return step ? step.name : `Step ${stepId}`;
  }

  function classifyDirection(stepMap, fromId, toId) {
    if (!fromId) return { kind: "entry", label: "Start", glyph: "●" };
    const from = stepMap.get(fromId);
    const to = stepMap.get(toId);
    if (!from || !to) return { kind: "unknown", label: "Moved", glyph: "–" };
    if (to.position > from.position) return { kind: "forward", label: "Forward", glyph: "↑" };
    if (to.position < from.position) return { kind: "backward", label: "Back", glyph: "↓" };
    return { kind: "lateral", label: "Same step", glyph: "–" };
  }

  function renderStatus(message) {
    view.innerHTML = "";
    const p = document.createElement("p");
    p.dataset.status = "";
    p.textContent = message;
    view.appendChild(p);
  }

  function renderError(message, onRetry) {
    view.innerHTML = "";
    const p = document.createElement("p");
    p.dataset.status = "";
    p.className = "status-error";
    p.textContent = message;
    view.appendChild(p);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "retry-button";
    button.textContent = "Retry";
    button.addEventListener("click", onRetry);
    view.appendChild(button);
  }

  // The transitions route returns rows newest-first and never a synthetic
  // "entered at creation" row on its own — some ledgers include one (a row
  // with from_workflow_step_id: null) and some don't. Detect which this
  // task's ledger gave us from its oldest (last) row, and only add the
  // implicit first-step visit when that row is missing, so the total never
  // double-counts an entry that was already recorded.
  function computeVisitCounts(transitions, currentStepId) {
    const counts = new Map();
    const bump = (stepId) => {
      if (!stepId) return;
      counts.set(stepId, (counts.get(stepId) || 0) + 1);
    };

    if (transitions.length === 0) {
      bump(currentStepId);
      return counts;
    }

    const oldest = transitions[transitions.length - 1];
    if (oldest.from_workflow_step_id) {
      bump(oldest.from_workflow_step_id);
    }
    transitions.forEach((transition) => bump(transition.to_workflow_step_id));
    return counts;
  }

  function renderWorkflowSequence(container, steps, currentStepId, visitedIds) {
    const section = document.createElement("section");
    section.className = "sequence-section";

    const heading = document.createElement("h2");
    heading.textContent = "Workflow path";
    section.appendChild(heading);

    const hint = document.createElement("p");
    hint.className = "section-hint";
    hint.textContent = "Every step defined in this workflow, in order. Highlighted steps are ones this task has actually visited.";
    section.appendChild(hint);

    const ordered = [...steps].sort((a, b) => a.position - b.position);
    const seq = document.createElement("ol");
    seq.className = "sequence";

    ordered.forEach((step, index) => {
      const li = document.createElement("li");
      const classes = ["sequence-step"];
      if (step.id === currentStepId) classes.push("is-current");
      else if (visitedIds.has(step.id)) classes.push("is-visited");
      li.className = classes.join(" ");

      const label = document.createElement("span");
      label.className = "sequence-step-label";
      label.textContent = step.name;
      li.appendChild(label);
      seq.appendChild(li);

      if (index < ordered.length - 1) {
        const sep = document.createElement("li");
        sep.className = "sequence-sep";
        sep.setAttribute("aria-hidden", "true");
        sep.textContent = "→";
        seq.appendChild(sep);
      }
    });

    section.appendChild(seq);
    container.appendChild(section);
  }

  function renderVisitSummary(container, counts, stepMap, currentStepId) {
    const section = document.createElement("section");
    section.className = "summary-section";

    const heading = document.createElement("h2");
    heading.textContent = "Visits per step";
    section.appendChild(heading);

    const orderedStepIds = Array.from(counts.keys()).sort((a, b) => {
      const posA = stepMap.has(a) ? stepMap.get(a).position : Number.MAX_SAFE_INTEGER;
      const posB = stepMap.has(b) ? stepMap.get(b).position : Number.MAX_SAFE_INTEGER;
      if (posA !== posB) return posA - posB;
      return String(a).localeCompare(String(b));
    });

    const maxVisits = Math.max(...orderedStepIds.map((id) => counts.get(id)));

    const list = document.createElement("ol");
    list.className = "visit-list";

    orderedStepIds.forEach((stepId) => {
      const isCurrent = stepId === currentStepId;
      const visits = counts.get(stepId);

      const item = document.createElement("li");
      item.className = `visit-row${isCurrent ? " is-current" : ""}`;

      const top = document.createElement("div");
      top.className = "visit-row-top";

      const name = document.createElement("span");
      name.className = "visit-name";
      name.textContent = stepLabel(stepMap, stepId);
      top.appendChild(name);

      if (isCurrent) {
        const currentTag = document.createElement("span");
        currentTag.className = "current-tag";
        currentTag.textContent = "Current";
        top.appendChild(currentTag);
      }

      const count = document.createElement("span");
      count.className = "visit-count";
      count.textContent = `${visits} visit${visits === 1 ? "" : "s"}`;
      top.appendChild(count);

      item.appendChild(top);

      const bar = document.createElement("div");
      bar.className = "visit-bar";
      const fill = document.createElement("div");
      fill.className = "visit-bar-fill";
      fill.style.width = `${Math.max(6, Math.round((visits / maxVisits) * 100))}%`;
      bar.appendChild(fill);
      item.appendChild(bar);

      list.appendChild(item);
    });

    section.appendChild(list);
    container.appendChild(section);
  }

  function renderEmptyTimeline(container) {
    const section = document.createElement("section");
    section.className = "timeline-section";
    const heading = document.createElement("h2");
    heading.textContent = "Chronological history";
    section.appendChild(heading);
    const p = document.createElement("p");
    p.dataset.status = "";
    p.textContent = "No moves yet — this task hasn't recorded a workflow step transition.";
    section.appendChild(p);
    container.appendChild(section);
  }

  function renderTimeline(container, transitions, stepMap, currentStepId) {
    const section = document.createElement("section");
    section.className = "timeline-section";
    const heading = document.createElement("h2");
    heading.textContent = "Chronological history";
    section.appendChild(heading);

    const list = document.createElement("ol");
    list.className = "timeline";

    transitions.forEach((transition, index) => {
      const direction = classifyDirection(
        stepMap,
        transition.from_workflow_step_id,
        transition.to_workflow_step_id
      );
      const isCurrent = index === 0 && transition.to_workflow_step_id === currentStepId;

      const item = document.createElement("li");
      item.className = `timeline-row direction-${direction.kind}${isCurrent ? " is-current" : ""}`;

      const marker = document.createElement("span");
      marker.className = "timeline-marker";
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = direction.glyph;
      item.appendChild(marker);

      const content = document.createElement("div");
      content.className = "timeline-content";

      const stepLine = document.createElement("div");
      stepLine.className = "timeline-step-line";

      const stepName = document.createElement("span");
      stepName.className = "timeline-step";
      stepName.textContent = stepLabel(stepMap, transition.to_workflow_step_id);
      stepLine.appendChild(stepName);

      const directionLabel = document.createElement("span");
      directionLabel.className = "timeline-direction-label";
      directionLabel.textContent = direction.label;
      stepLine.appendChild(directionLabel);

      if (isCurrent) {
        const currentTag = document.createElement("span");
        currentTag.className = "current-tag";
        currentTag.textContent = "Current";
        stepLine.appendChild(currentTag);
      }

      content.appendChild(stepLine);

      const metaLine = document.createElement("div");
      metaLine.className = "timeline-meta-line";

      const time = document.createElement("time");
      time.className = "timeline-time";
      time.dateTime = transition.occurred_at;
      time.textContent = formatTimestamp(transition.occurred_at);
      metaLine.appendChild(time);

      if (transition.trigger) {
        const trigger = document.createElement("span");
        trigger.className = "timeline-trigger";
        trigger.textContent = transition.trigger;
        metaLine.appendChild(trigger);
      }

      content.appendChild(metaLine);
      item.appendChild(content);
      list.appendChild(item);
    });

    section.appendChild(list);
    container.appendChild(section);
  }

  async function load() {
    renderStatus("Loading step history…");
    try {
      const context = await fetchJson(`${API}/context`);
      const taskId = context.task_id;
      if (!taskId) {
        renderError("This canvas has no bound task.", load);
        return;
      }

      const task = await fetchJson(`${API}/data/tasks/${taskId}`);
      const stepMap = new Map();
      let steps = [];
      if (task.workflow_id) {
        steps = await fetchAllPages(`${API}/data/workflows/${task.workflow_id}/steps`, 200);
        steps.forEach((step) => stepMap.set(step.id, step));
      }

      const transitions = await fetchAllPages(
        `${API}/data/tasks/${taskId}/step-transitions`,
        200
      );

      const counts = computeVisitCounts(transitions, task.workflow_step_id);

      view.innerHTML = "";

      if (steps.length > 0) {
        renderWorkflowSequence(view, steps, task.workflow_step_id, new Set(counts.keys()));
      }

      renderVisitSummary(view, counts, stepMap, task.workflow_step_id);

      if (transitions.length === 0) {
        renderEmptyTimeline(view);
      } else {
        renderTimeline(view, transitions, stepMap, task.workflow_step_id);
      }
    } catch (error) {
      renderError(`Couldn't load step history: ${error.message}`, load);
    }
  }

  load();
})();
