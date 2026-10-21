"""CFB (FBS) adapter: ESPN/sportsdataverse play-by-play -> opponent-adjusted
unit ratings (pass O/D, rush O/D) for every FBS team AND every FCS / lower-
division team that appears in the play-by-play, a quarterback layer, priors
(last season regressed, conference, roster talent, returning production), a
market rating from prior closing spreads, home field fitted walk-forward with
neutral sites honoured, and a key-number margin distribution fitted on CFB."""
import os

# The rating fits solve many mid-sized systems; a multi-threaded BLAS gains
# nothing on them and thrashes when the tuner runs fits in parallel processes.
# Set before numpy loads (an explicit setting in the environment wins).
for _v in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")
