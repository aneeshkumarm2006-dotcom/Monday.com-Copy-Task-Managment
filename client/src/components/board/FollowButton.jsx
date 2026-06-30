import { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import {
  getFollowState,
  followTask,
  unfollowTask,
} from '../../services/followService';
import useToastStore from '../../store/toastStore';

/**
 * Follow/watch toggle for a task. Following a task opts you into its activity
 * notifications (updates, status changes, moves, due-date changes) even when
 * you aren't assigned or mentioned. Shown in the task detail panel header.
 */
const FollowButton = ({ taskId, isOpen }) => {
  const [following, setFollowing] = useState(false);
  const [loading, setLoading] = useState(false);
  const toastError = useToastStore((s) => s.error);

  useEffect(() => {
    if (!isOpen || !taskId) return undefined;
    let active = true;
    getFollowState(taskId)
      .then((f) => {
        if (active) setFollowing(f);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [isOpen, taskId]);

  const toggle = async () => {
    if (!taskId || loading) return;
    const next = !following;
    setFollowing(next);
    setLoading(true);
    try {
      if (next) await followTask(taskId);
      else await unfollowTask(taskId);
    } catch {
      setFollowing(!next);
      toastError('Could not update follow state.');
    } finally {
      setLoading(false);
    }
  };

  const Icon = following ? Eye : EyeOff;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={following}
      aria-label={following ? 'Unfollow this task' : 'Follow this task'}
      title={
        following
          ? 'You are watching this task — click to stop'
          : 'Watch this task to get notified of its activity'
      }
      className="inline-flex items-center gap-1.5 font-body transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
      style={{
        height: 32,
        padding: '0 10px',
        fontSize: 12,
        fontWeight: 500,
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        color: following
          ? 'var(--color-accent-text)'
          : 'var(--color-text-secondary)',
        background: following ? 'var(--color-accent-light)' : 'transparent',
        border: `1px solid ${
          following ? 'transparent' : 'var(--color-border)'
        }`,
      }}
    >
      <Icon size={14} aria-hidden="true" />
      {following ? 'Following' : 'Follow'}
    </button>
  );
};

export default FollowButton;
