import { useAppStore } from "../stores/app-store";

export function CommitmentsView(): React.JSX.Element {
  const activeProject = useAppStore((s) => s.activeProject);

  if (!activeProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[#8b8b92]">Select a project to view commitments</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[#26262c] px-6 py-3">
        <h2 className="text-sm font-medium text-white">
          Commitments &mdash; {activeProject.name}
        </h2>
        <button className="rounded-md bg-[#d97706] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#b45309]">
          + New commitment
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl">
          {/* Upcoming section */}
          <section className="mb-8">
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
              Upcoming
            </h3>
            <EmptyCommitments section="upcoming" />
          </section>

          {/* Active section */}
          <section className="mb-8">
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
              Active
            </h3>
            <EmptyCommitments section="active" />
          </section>

          {/* Paused section */}
          <section>
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
              Paused
            </h3>
            <EmptyCommitments section="paused" />
          </section>
        </div>
      </div>
    </div>
  );
}

function EmptyCommitments({ section }: { section: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-[#26262c] p-6 text-center">
      <p className="text-sm text-[#8b8b92]">
        No {section} commitments. Ask Emerson to set one up, or create one
        manually.
      </p>
    </div>
  );
}
