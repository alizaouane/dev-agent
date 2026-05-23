import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader } from '@/components/ui/page-header';

describe('<PageHeader>', () => {
  it('renders the title as an h1 and the descriptor below it', () => {
    render(<PageHeader title="Home" descriptor="What needs you, across all repos." />);
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText('What needs you, across all repos.')).toBeInTheDocument();
  });

  it('mounts a Term (?) bubble next to the title when helpTerm is set', () => {
    render(<PageHeader title="Home" descriptor="d" helpTerm="home-page" />);
    expect(screen.getByRole('button', { name: /what is home/i })).toBeInTheDocument();
  });

  it('omits the (?) bubble when helpTerm is not set', () => {
    render(<PageHeader title="Home" descriptor="d" />);
    expect(screen.queryByRole('button', { name: /what is/i })).toBeNull();
  });

  it('renders actions in the right-side slot', () => {
    render(
      <PageHeader title="Home" descriptor="d" actions={<button>Do thing</button>} />,
    );
    expect(screen.getByRole('button', { name: 'Do thing' })).toBeInTheDocument();
  });
});
