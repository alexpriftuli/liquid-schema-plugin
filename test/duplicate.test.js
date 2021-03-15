const compile = require('./utils/compile');

describe('duplicate-test', () => {
    it('supports external tag with no endtag tag', done => {
        const filename = 'duplicate-test';

        compile(filename, done);
    }, 10000);
});
