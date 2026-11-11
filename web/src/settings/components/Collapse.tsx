import { type ReactNode, useEffect, useState } from "react";

export function Collapse({
  open,
  children,
  id,
}: {
  open: boolean;
  children: ReactNode;
  id?: string;
}) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  return (
    <div id={id} className={`settings-collapse ${open ? "is-open" : ""}`} inert={!open}>
      <div className="min-h-0 overflow-hidden">{mounted ? children : null}</div>
    </div>
  );
}
