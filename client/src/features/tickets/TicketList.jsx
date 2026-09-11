import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { api } from '../../app/api';

const STATUSES    = ['', 'open', 'pending', 'resolved', 'closed'];
const PRIORITIES  = ['', 'P1', 'P2', 'P3'];

// SLA badge visual config
const SLA_LABEL = { MET: 'MET', WITHIN_SLA: 'WITHIN SLA', BREACHED: 'BREACHED', UNKNOWN: '—' };
const SLA_COLOR = { MET: '#2e7d32', WITHIN_SLA: '#1565c0', BREACHED: '#c62828', UNKNOWN: '#555' };

function SlaBadge({ sla }) {
  if (!sla) return <td>—</td>;
  return (
    <td>
      <span
        title={sla.deadline ? `Due ${new Date(sla.deadline).toLocaleString()}` : ''}
        style={{
          display: 'inline-block',
          padding: '2px 8px',
          borderRadius: '4px',
          fontSize: '0.75rem',
          fontWeight: 600,
          color: '#fff',
          backgroundColor: SLA_COLOR[sla.state] || '#555',
        }}
      >
        {SLA_LABEL[sla.state] || sla.state}
      </span>
    </td>
  );
}

export default function TicketList() {
  const user = useSelector((s) => s.auth.user);

  const [rows, setRows]           = useState([]);
  const [total, setTotal]         = useState(0);
  const [page, setPage]           = useState(1);
  const [search, setSearch]       = useState('');
  const [status, setStatus]       = useState('');
  const [priority, setPriority]   = useState('');
  const [sortBy, setSortBy]       = useState('created_at');
  const [slaState, setSlaState]       = useState('');
  const [loading, setLoading]     = useState(false);

  // Fix BUG-09: all filter state included in deps so changing any filter re-fetches.
  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({
      page,
      search,
      status,
      priority,
      sortBy,
      order: 'desc',
      ...(slaState ? { slaState } : {}),
    });
    api(`/tickets?${params.toString()}`)
      .then((data) => {
        setRows(data.rows);
        setTotal(data.total);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, search, status, priority, sortBy, slaState]);

  async function handleDelete(id) {
    await api(`/tickets/${id}`, { method: 'DELETE' });
    setRows(rows.filter((r) => r.id !== id));
  }

  // Reset to page 1 whenever a filter changes (prevents empty results on later pages).
  function handleFilterChange(setter) {
    return (e) => {
      setter(typeof e === 'boolean' ? e : e.target.value);
      setPage(1);
    };
  }

  const pageCount = Math.ceil(total / 20);

  return (
    <div className="ticket-list">
      <h1>Tickets</h1>

      <div className="filters">
        <input
          placeholder="Search subject…"
          value={search}
          onChange={handleFilterChange(setSearch)}
        />
        <select value={status} onChange={handleFilterChange(setStatus)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s || 'Any status'}</option>
          ))}
        </select>
        <select value={priority} onChange={handleFilterChange(setPriority)}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>{p || 'Any priority'}</option>
          ))}
        </select>
        <select value={sortBy} onChange={handleFilterChange(setSortBy)}>
          <option value="created_at">Created</option>
          <option value="updated_at">Updated</option>
          <option value="priority">Priority</option>
          <option value="status">Status</option>
        </select>
        <select value={slaState} onChange={handleFilterChange(setSlaState)}>
          <option value="">SLA status</option>
          <option value="WITHIN_SLA">Within SLA</option>
          <option value="MET">Met</option>
          <option value="BREACHED">Breached</option>
        </select>
      </div>

      {loading && <p>Loading…</p>}

      <table>
        <thead>
          <tr>
            <th>#</th><th>Subject</th><th>Status</th><th>Priority</th>
            <th>Assignee</th><th>Comments</th><th>SLA</th><th>Created</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => (
            <tr key={i}>
              <td>{t.id}</td>
              <td><Link to={`/tickets/${t.id}`}>{t.subject}</Link></td>
              <td>{t.status}</td>
              <td>{t.priority}</td>
              <td>{t.assignee_name || '—'}</td>
              <td>{t.comment_count}</td>
              <SlaBadge sla={t.sla} />
              <td>{new Date(t.created_at).toLocaleString()}</td>
              <td>
                {user?.role === 'admin' && (
                  <button onClick={() => handleDelete(t.id)}>Delete</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pager">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span>Page {page} of {pageCount || 1} · {total} tickets</span>
        <button disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}
