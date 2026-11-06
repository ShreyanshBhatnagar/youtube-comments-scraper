# Apify Actor image — Node.js 22 base maintained by Apify.
FROM apify/actor-node:22

# Copy package files first for better Docker layer caching.
COPY --chown=myuser:myuser package*.json ./

# Install production dependencies.
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

# Copy the rest of the source code.
COPY --chown=myuser:myuser . ./

# Run the Actor.
CMD ["npm", "start"]
