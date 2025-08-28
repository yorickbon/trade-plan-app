// key tweaks inside HeadlinesPanel.tsx

// 1) Cap the list to 6 with a collapsible "Show more"
const MAX_VISIBLE = 6;
const [expanded, setExpanded] = useState(false);
const visible = expanded ? items : items.slice(0, MAX_VISIBLE);

// 2) UI
<div className="space-y-2 max-h-[220px] overflow-y-auto pr-2">
  {visible.map((h, i) => (
    <div key={i} className="text-sm leading-5">
      <a href={h.url} target="_blank" className="underline hover:no-underline">{h.title}</a>
      <div className="text-[11px] opacity-70">
        {h.source ?? h.provider} · {new Date(h.published_at).toLocaleString()} · {h.sentiment?.label}
      </div>
    </div>
  ))}
  {items.length > MAX_VISIBLE && (
    <button className="text-xs underline mt-2" onClick={() => setExpanded(!expanded)}>
      {expanded ? "Show less" : `Show ${items.length - MAX_VISIBLE} more`}
    </button>
  )}
</div>
