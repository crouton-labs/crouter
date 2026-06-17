import { useParams } from 'react-router-dom';
import { ViewHost } from '../ViewHost.js';

// Builtin views are bundled, not node-authored — there is no authoring node to
// open a "refine this view" chat drawer against, so the view page is just the
// ViewHost.
export function ViewPage({ viewId }: { viewId: string; tab?: string }): React.ReactElement {
  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-auto">
        <ViewHost viewId={viewId} />
      </div>
    </div>
  );
}

export function ViewPageRoute(): React.ReactElement {
  const { viewId, tab } = useParams<{ viewId: string; tab?: string }>();
  return <ViewPage viewId={viewId ?? ''} tab={tab} />;
}
