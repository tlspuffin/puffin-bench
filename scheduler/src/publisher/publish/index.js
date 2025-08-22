function ToggleDetails(key) {
  const details = document.getElementById('details-' + key);
  details.style.display = details.style.display === 'none' ? 'block' : 'none';
}

document.getElementById('status-filter').addEventListener('change', ApplyFilters);
document.getElementById('period-filter').addEventListener('change', ApplyFilters);
document.getElementById('search-filter').addEventListener('input', ApplyFilters);

function ApplyFilters() {
  const statusFilter = document.getElementById('status-filter').value;
  const periodFilter = document.getElementById('period-filter').value;
  const searchFilter = document.getElementById('search-filter').value.toLowerCase();

  const now = Date.now();
  const periodMs = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000
  };

  document.querySelectorAll('.report-card').forEach(card => {
    let visible = true;

    if (statusFilter && !card.classList.contains('report-' + statusFilter)) {
      visible = false;
    }

    if (periodFilter && periodMs[periodFilter]) {
      const epoch = parseInt(card.dataset.epoch);
      if (now - epoch > periodMs[periodFilter]) {
        visible = false;
      }
    }

    if (searchFilter) {
      const commitGroup = card.closest('.commit-group');
      const commit = commitGroup.dataset.commit.toLowerCase();
      if (!commit.includes(searchFilter)) {
        visible = false;
      }
    }

    card.style.display = visible ? 'block' : 'none';
  });

  document.querySelectorAll('.commit-group').forEach(group => {
    const visibleCards = group.querySelectorAll('.report-card:not([style*="none"])');
    group.style.display = visibleCards.length > 0 ? 'block' : 'none';
  });
}