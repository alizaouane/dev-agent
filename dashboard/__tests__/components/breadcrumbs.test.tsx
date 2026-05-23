import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Breadcrumbs, crumbsForPath } from '@/components/ui/breadcrumbs';

describe('<Breadcrumbs>', () => {
  it('renders nothing when crumbs is empty', () => {
    const { container } = render(<Breadcrumbs crumbs={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders intermediate crumbs as links and the last as plain text', () => {
    render(
      <Breadcrumbs
        crumbs={[
          { label: 'Home', href: '/' },
          { label: 'Repos', href: '/repos' },
          { label: 'qualiency/web' },
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Repos' })).toBeInTheDocument();
    // Last crumb is current page — no link
    expect(screen.queryByRole('link', { name: 'qualiency/web' })).toBeNull();
    expect(screen.getByText('qualiency/web')).toBeInTheDocument();
  });
});

describe('crumbsForPath', () => {
  it('returns [] for top-level routes', () => {
    expect(crumbsForPath('/', null)).toEqual([]);
    expect(crumbsForPath('/repos', null)).toEqual([]);
    expect(crumbsForPath('/intent', null)).toEqual([]);
    expect(crumbsForPath('/pipeline', null)).toEqual([]);
    expect(crumbsForPath('/proposals', null)).toEqual([]);
    expect(crumbsForPath('/activity', null)).toEqual([]);
    expect(crumbsForPath('/cost', null)).toEqual([]);
  });

  it('builds Home › Repos › :name for /repos/:name', () => {
    expect(crumbsForPath('/repos/qualiency-web', null)).toEqual([
      { label: 'Home', href: '/' },
      { label: 'Repos', href: '/repos' },
      { label: 'qualiency-web' },
    ]);
  });

  it('builds Home › Features › #:issue for /features/:issue', () => {
    expect(crumbsForPath('/features/142', null)).toEqual([
      { label: 'Home', href: '/' },
      { label: 'Features', href: '/pipeline' },
      { label: '#142' },
    ]);
  });

  it('enriches /intent with repo from query string when present', () => {
    expect(crumbsForPath('/intent', 'qualiency-web')).toEqual([
      { label: 'Home', href: '/' },
      { label: 'Brainstorm', href: '/intent' },
      { label: 'qualiency-web' },
    ]);
  });

  it('returns [] for /intent without a repo query', () => {
    expect(crumbsForPath('/intent', null)).toEqual([]);
  });
});
