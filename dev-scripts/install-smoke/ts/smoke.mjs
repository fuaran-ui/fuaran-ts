// The npm leg of the clean-machine install smoke — see ../README.md.
//
// Authored against the PUBLISHED `@fuaran-ui/*` surface only: no workspace
// import, no relative path out of this directory, nothing this repository
// builds. If it can run here it can run in an empty folder on a stranger's
// laptop, which is the whole claim.
import { format, fuaran } from '@fuaran-ui/ui';
import { encodeNode } from '@fuaran-ui/ops';

const tree = fuaran.dashboard({
  id: 'smoke',
  children: [
    fuaran.heading({ id: 'smoke-heading', level: 1, text: 'Clean-machine install smoke' }),
    fuaran.metric({
      id: 'smoke-metric',
      label: 'Revenue',
      value: 142500,
      format: format.currency('GBP'),
      tone: 'Brand',
    }),
  ],
});

process.stdout.write(encodeNode(tree) + '\n');
