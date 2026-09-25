import EntityLogo from '../ui/EntityLogo';
import { PORTAL_BRAND_INITIAL } from '../../utils/portalBrand';

/**
 * The portal's brand mark: the workspace's own logo when it has uploaded one,
 * else the product's lettered gradient mark (`.mcp-brand-mark`), unchanged.
 */
const PortalBrandMark = ({ logo = '', size = 40, style }) =>
  logo ? (
    <EntityLogo src={logo} name="Brand" size={size} radius={Math.round(size * 0.27)} style={style} />
  ) : (
    <span className="mcp-brand-mark" style={{ width: size, height: size, ...style }}>
      {PORTAL_BRAND_INITIAL}
    </span>
  );

export default PortalBrandMark;
