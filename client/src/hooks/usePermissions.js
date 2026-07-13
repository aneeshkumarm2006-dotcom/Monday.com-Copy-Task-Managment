import { useMemo } from 'react';
import usePermissionStore from '../store/permissionStore';

/**
 * usePermissions — ask what the current user may do.
 *
 *   const { can, isOwner, role } = usePermissions();
 *   {can('board.create') && <Button>New board</Button>}
 *
 * These are ORG-wide capabilities. A capability that is board-scoped
 * (`task.delete`, `column.manage`, …) means "this user's role permits it
 * SOMEWHERE" — whether they may do it on a PARTICULAR board also depends on their
 * access to that board, which is the second half of the AND. For board-scoped
 * gates use the `permissions` the board endpoint returns for that board, exposed
 * via `useBoardPermissions` below.
 *
 * Hiding a button is a courtesy, not a control. The server enforces every one of
 * these independently.
 */
const usePermissions = () => {
  const capabilities = usePermissionStore((s) => s.capabilities);
  const role = usePermissionStore((s) => s.role);
  const isOwner = usePermissionStore((s) => s.isOwner);
  const loading = usePermissionStore((s) => s.loading);

  return useMemo(() => {
    const set = new Set(capabilities);
    return {
      can: (capability) => set.has(capability),
      canAny: (...caps) => caps.some((c) => set.has(c)),
      canAll: (...caps) => caps.every((c) => set.has(c)),
      capabilities: set,
      role,
      isOwner,
      loading,
    };
  }, [capabilities, role, isOwner, loading]);
};

/**
 * The same interface, for the capability set the server resolved FOR ONE BOARD —
 * i.e. the two-layer AND already applied. Pass whatever `board.permissions` the
 * board endpoint returned.
 *
 *   const { can } = useBoardPermissions(board?.permissions);
 *   <TaskRow readOnly={!can('task.edit_any')} />
 */
export const useBoardPermissions = (boardPermissions) =>
  useMemo(() => {
    const set = new Set(boardPermissions?.capabilities || []);
    return {
      can: (capability) => set.has(capability),
      canAny: (...caps) => caps.some((c) => set.has(c)),
      capabilities: set,
      /** The rung they stand on: view | comment | contribute | edit | null. */
      level: boardPermissions?.level || null,
      canRead: boardPermissions?.canRead !== false,
      readOnly: !!boardPermissions?.readOnly,
      isBoardOwner: !!boardPermissions?.isBoardOwner,
      canManageAccess: !!boardPermissions?.canManageAccess,
      canViewAccess: !!boardPermissions?.canViewAccess,
    };
  }, [boardPermissions]);

export default usePermissions;
